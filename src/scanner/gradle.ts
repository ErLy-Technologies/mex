import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

export interface GradleDependency {
  group: string;
  name: string;
  version: string;
}

const BUILD_FILES = ["build.gradle", "build.gradle.kts"] as const;
const SETTINGS_FILES = ["settings.gradle", "settings.gradle.kts"] as const;
const SKIPPED_DIRS = new Set(["node_modules", "build", "out", "target", "dist", "gradle", "buildSrc"]);

const COORD = "[A-Za-z0-9_.\\-]+";
const VERSION = "[A-Za-z0-9_.\\-+${}]+";

/** `'group:name:version[:classifier]'` — Groovy and Kotlin string notation */
const STRING_NOTATION = new RegExp(
  `["'](${COORD}):(${COORD}):(${VERSION})(?::${COORD})?["']`,
  "g"
);

/** `group: 'g', name: 'n'[, version: 'v' | version: someVar]` — also `=` for Kotlin named args */
const MAP_NOTATION = new RegExp(
  `group\\s*[:=]\\s*["'](${COORD})["']\\s*,\\s*name\\s*[:=]\\s*["'](${COORD})["']` +
    `(?:\\s*,\\s*version\\s*[:=]\\s*(?:["']([^"'\\n]*)["']|([A-Za-z_][\\w.]*)))?`,
  "g"
);

/** `ext.x = '1.0'`, `val x = "1.0"`, `def x = '1.0'`, and `x = '1.0'` at line start or inside `ext { }` */
const VARIABLE = /(?:\bext\.|\b(?:val|var|def)\s+|^[ \t]*|[{;][ \t]*)([A-Za-z_]\w*)\s*=\s*["']([^"'$\n]*)["']/gm;

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Collect simple string variables (ext properties, vals, defs) from a build script */
export function parseGradleVariables(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const m of stripComments(content).matchAll(VARIABLE)) {
    vars[m[1]] = m[2];
  }
  return vars;
}

function resolveVersion(raw: string, vars: Record<string, string>): string {
  const interpolated = raw.replace(/\$\{([A-Za-z_][\w.]*)\}|\$([A-Za-z_]\w*)/g, (whole, braced, bare) => {
    const key = (braced ?? bare) as string;
    return vars[key.replace(/^(?:project\.)?(?:ext\.)?/, "")] ?? whole;
  });
  return interpolated;
}

/** Parse dependency coordinates from one Gradle build script (Groovy or Kotlin DSL) */
export function parseGradleDependencies(
  content: string,
  inheritedVars: Record<string, string> = {}
): GradleDependency[] {
  const text = stripComments(content);
  const vars = { ...inheritedVars, ...parseGradleVariables(text) };
  const deps: GradleDependency[] = [];

  for (const m of text.matchAll(MAP_NOTATION)) {
    let version = "";
    if (m[3] !== undefined) version = resolveVersion(m[3], vars);
    else if (m[4] !== undefined) version = vars[m[4].replace(/^(?:project\.)?(?:ext\.)?/, "")] ?? m[4];
    deps.push({ group: m[1], name: m[2], version });
  }

  for (const m of text.matchAll(STRING_NOTATION)) {
    deps.push({ group: m[1], name: m[2], version: resolveVersion(m[3], vars) });
  }

  return deps;
}

function firstExisting(dir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function includedProjectDirs(settings: string): string[] {
  const dirs: string[] = [];
  const text = stripComments(settings);
  for (const m of text.matchAll(/\binclude\b\s*(\(([^)]*)\)|[^\n]*)/g)) {
    const args = m[2] ?? m[1];
    for (const s of args.matchAll(/["']([^"']+)["']/g)) {
      dirs.push(s[1].replace(/^:/, "").replace(/:/g, "/"));
    }
  }
  return dirs;
}

/** Root build file plus subproject build files (from settings.gradle, else immediate subdirectories) */
export function findGradleBuildFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const root = firstExisting(projectRoot, BUILD_FILES);
  if (root) files.push(root);

  const settingsPath = firstExisting(projectRoot, SETTINGS_FILES);
  let dirs: string[];
  if (settingsPath) {
    dirs = includedProjectDirs(readFileSync(settingsPath, "utf-8"));
  } else if (root) {
    dirs = readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIPPED_DIRS.has(d.name))
      .map((d) => d.name);
  } else {
    return files;
  }

  for (const dir of dirs) {
    const file = firstExisting(resolve(projectRoot, dir), BUILD_FILES);
    if (file) files.push(file);
  }
  return files;
}

/** All dependencies declared across a Gradle build; root variables are visible in subprojects */
export function loadGradleDependencies(projectRoot: string): GradleDependency[] {
  const files = findGradleBuildFiles(projectRoot);
  if (!files.length) return [];

  const rootFile = firstExisting(projectRoot, BUILD_FILES);
  const rootVars = rootFile ? parseGradleVariables(readFileSync(rootFile, "utf-8")) : {};

  const seen = new Set<string>();
  const deps: GradleDependency[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const dep of parseGradleDependencies(content, rootVars)) {
      const key = `${dep.group}:${dep.name}:${dep.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deps.push(dep);
    }
  }
  return deps;
}
