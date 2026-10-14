import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, DriftIssue } from "../../types.js";
import { loadGradleDependencies } from "../../scanner/gradle.js";

/** Runtimes, platforms, databases, protocols, and architectural terms that appear in stack docs but aren't installable packages */
const KNOWN_RUNTIMES = new Set([
  "node.js", "node", "nodejs",
  "python", "cpython",
  "go", "golang",
  "rust",
  "ruby",
  "java", "jdk", "jre",
  "deno", "bun",
  "swift", "kotlin", "elixir", "erlang", "php",
  ".net", "dotnet", "c#", "csharp",
  "sqlite", "sqlite3",
  "postgresql", "postgres",
  "mysql", "mariadb",
  "mongodb", "mongo",
  "redis",
  "elasticsearch",
  "dynamodb", "cassandra", "neo4j", "supabase", "neon",
  "docker",
  "kubernetes", "k8s",
  "vercel", "netlify", "railway", "fly.io", "render",
  "aws", "gcp", "azure", "cloudflare",
  "s3", "ec2", "lambda", "ecs", "fargate",
  "rest", "rest api", "graphql", "grpc", "websocket", "websockets",
  "oauth", "oauth2", "jwt", "saml", "oidc",
  "http", "https", "tcp", "udp",
  "tailwind", "tailwind css", "tailwindcss",
  "bootstrap", "sass", "less", "postcss",
  "webpack", "vite", "esbuild", "turbopack", "rollup", "parcel",
  "git", "github", "gitlab", "ci/cd", "nginx", "apache", "caddy",
  "gradle", "maven", "tomcat",
  "linux", "macos", "windows", "wasm", "webassembly",
]);

/** Check that claimed dependencies exist in manifests */
export function checkDependencies(
  claims: Claim[],
  projectRoot: string
): DriftIssue[] {
  const issues: DriftIssue[] = [];
  const deps = loadAllDependencies(projectRoot);
  if (!deps) return issues;

  const depClaims = claims.filter(
    (c) => c.kind === "dependency" && !c.negated
  );
  const versionClaims = claims.filter(
    (c) => c.kind === "version" && !c.negated
  );

  for (const claim of depClaims) {
    const name = claim.value.toLowerCase();

    // Skip known runtimes/platforms — they won't be in a manifest
    if (KNOWN_RUNTIMES.has(name)) continue;

    if (!deps.some((d) => matches(name, d))) {
      issues.push({
        code: "DEPENDENCY_MISSING",
        severity: "warning",
        file: claim.source,
        line: claim.line,
        message: `Claimed dependency "${claim.value}" not found in any manifest`,
        claim,
      });
    }
  }

  for (const claim of versionClaims) {
    // Parse "React 18" or "Node v20"
    const match = claim.value.match(/^(.+?)\s+v?(\d[\d.]*\S*)$/);
    if (!match) continue;

    const name = match[1].trim().toLowerCase();
    const claimedVersion = match[2];

    // "MySQL 5.6" is the server, not the JDBC driver in the manifest
    if (KNOWN_RUNTIMES.has(name)) continue;
    const found = deps.filter((d) => matches(name, d) && d.version);

    if (found.length && !found.some((d) => d.version.includes(claimedVersion))) {
      issues.push({
        code: "VERSION_MISMATCH",
        severity: "warning",
        file: claim.source,
        line: claim.line,
        message: `Claimed "${claim.value}" but manifest has version "${found[0].version}"`,
        claim,
      });
    }
  }

  return issues;
}

interface DepEntry {
  name: string;
  version: string;
  /** Maven group id; set only for Gradle dependencies */
  group?: string;
}

/**
 * Does a claimed name (lower-cased) refer to this dependency?
 * npm: exact package name ("React" → "react").
 * Gradle: artifact ("Lombok" → lombok), artifact family ("Spring" → spring-core),
 * spaced artifact ("Spring Data JPA" → spring-data-jpa), group segment
 * ("Stripe" → com.stripe) or group/artifact ("auth0/java-jwt").
 */
function matches(claimed: string, dep: DepEntry): boolean {
  const artifact = dep.name.toLowerCase();
  if (artifact === claimed) return true;
  if (dep.group === undefined) return false;

  const group = dep.group.toLowerCase();
  const kebab = claimed.trim().replace(/\s+/g, "-");
  const segments = group.split(".");
  return (
    artifact === kebab ||
    artifact.startsWith(kebab + "-") ||
    segments.includes(kebab) ||
    claimed === `${segments[segments.length - 1]}/${artifact}` ||
    claimed === `${group}:${artifact}`
  );
}

function loadAllDependencies(projectRoot: string): DepEntry[] | null {
  const entries: DepEntry[] = [];

  // package.json
  const pkgPath = resolve(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
      for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
        entries.push({ name, version: String(version) });
      }
    } catch {
      // skip
    }
  }

  for (const dep of loadGradleDependencies(projectRoot)) {
    entries.push({ name: dep.name, version: dep.version, group: dep.group });
  }

  return entries.length ? entries : null;
}
