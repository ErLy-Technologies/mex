import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseGradleDependencies,
  findGradleBuildFiles,
  loadGradleDependencies,
} from "../src/scanner/gradle.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mex-gradle-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseGradleDependencies", () => {
  it("parses map notation with single and double quotes", () => {
    const deps = parseGradleDependencies(`
      dependencies {
        compile group: 'org.hibernate', name: 'hibernate-core', version: '5.2.5.Final'
        implementation group: "com.sendgrid", name: "sendgrid-java", version: "4.3.0"
      }
    `);
    expect(deps).toContainEqual({ group: "org.hibernate", name: "hibernate-core", version: "5.2.5.Final" });
    expect(deps).toContainEqual({ group: "com.sendgrid", name: "sendgrid-java", version: "4.3.0" });
  });

  it("parses map notation inside list literals and without a version", () => {
    const deps = parseGradleDependencies(`
      List depsCommons = [
          [group: 'commons-io', name: 'commons-io', version: '2.4'],
      ]
      compile group: 'io.micrometer', name: 'micrometer-registry-jmx'
    `);
    expect(deps).toContainEqual({ group: "commons-io", name: "commons-io", version: "2.4" });
    expect(deps).toContainEqual({ group: "io.micrometer", name: "micrometer-registry-jmx", version: "" });
  });

  it("parses string notation including Kotlin DSL and classifiers", () => {
    const deps = parseGradleDependencies(`
      compile 'com.stripe:stripe-java:33.4.2'
      compileOnly 'org.projectlombok:lombok:1.18.8'
      implementation("com.squareup.okhttp3:okhttp:4.12.0")
      classpath "org.liquibase:liquibase-gradle-plugin:2.1.0"
      compile 'net.sf.json-lib:json-lib:2.4:jdk15'
    `);
    expect(deps).toContainEqual({ group: "com.stripe", name: "stripe-java", version: "33.4.2" });
    expect(deps).toContainEqual({ group: "org.projectlombok", name: "lombok", version: "1.18.8" });
    expect(deps).toContainEqual({ group: "com.squareup.okhttp3", name: "okhttp", version: "4.12.0" });
    expect(deps).toContainEqual({ group: "org.liquibase", name: "liquibase-gradle-plugin", version: "2.1.0" });
    expect(deps).toContainEqual({ group: "net.sf.json-lib", name: "json-lib", version: "2.4" });
  });

  it("resolves version variables from ext blocks, ext assignments and Kotlin vals", () => {
    const deps = parseGradleDependencies(`
      ext {
          v_spring = '5.3.39'
      }
      ext.v_jackson = "2.9.2"
      val ktorVersion = "2.3.0"
      compile group: 'org.springframework', name: 'spring-core', version: v_spring
      compile "com.fasterxml.jackson.core:jackson-core:\${v_jackson}"
      implementation("io.ktor:ktor-server-core:$ktorVersion")
    `);
    expect(deps).toContainEqual({ group: "org.springframework", name: "spring-core", version: "5.3.39" });
    expect(deps).toContainEqual({ group: "com.fasterxml.jackson.core", name: "jackson-core", version: "2.9.2" });
    expect(deps).toContainEqual({ group: "io.ktor", name: "ktor-server-core", version: "2.3.0" });
  });

  it("ignores comments, URLs and non-coordinate strings", () => {
    const deps = parseGradleDependencies(`
      // compile 'com.example:commented-out:1.0'
      /* compile 'com.example:block-commented:1.0' */
      url "https://plugins.gradle.org/m2/"
      url "jdbc:mysql://localhost:3306/db"
      println("Execute SSH Tunnel setup")
    `);
    expect(deps).toEqual([]);
  });
});

describe("findGradleBuildFiles", () => {
  it("returns the root build file and included subprojects", () => {
    writeFileSync(join(tmpDir, "build.gradle"), "");
    writeFileSync(join(tmpDir, "settings.gradle"), "include(\n  'app',\n  ':libs:core'\n)\ninclude 'other'");
    mkdirSync(join(tmpDir, "app"));
    writeFileSync(join(tmpDir, "app", "build.gradle"), "");
    mkdirSync(join(tmpDir, "libs", "core"), { recursive: true });
    writeFileSync(join(tmpDir, "libs", "core", "build.gradle.kts"), "");
    const files = findGradleBuildFiles(tmpDir).map((f) => f.slice(tmpDir.length + 1)).sort();
    expect(files).toEqual(["app/build.gradle", "build.gradle", "libs/core/build.gradle.kts"]);
  });

  it("falls back to immediate subdirectories when there is no settings file", () => {
    writeFileSync(join(tmpDir, "build.gradle"), "");
    mkdirSync(join(tmpDir, "module-a"));
    writeFileSync(join(tmpDir, "module-a", "build.gradle"), "");
    mkdirSync(join(tmpDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "x", "build.gradle"), "");
    const files = findGradleBuildFiles(tmpDir).map((f) => f.slice(tmpDir.length + 1)).sort();
    expect(files).toEqual(["build.gradle", "module-a/build.gradle"]);
  });

  it("returns nothing for a non-Gradle project", () => {
    expect(findGradleBuildFiles(tmpDir)).toEqual([]);
  });
});

describe("loadGradleDependencies", () => {
  it("resolves root ext variables in subproject build files", () => {
    writeFileSync(join(tmpDir, "settings.gradle"), "include 'core'");
    writeFileSync(join(tmpDir, "build.gradle"), "ext { lib_version = '1.0.5.1' }");
    mkdirSync(join(tmpDir, "core"));
    writeFileSync(
      join(tmpDir, "core", "build.gradle"),
      "compile group: 'com.acme', name: 'base', version: lib_version"
    );
    expect(loadGradleDependencies(tmpDir)).toContainEqual({ group: "com.acme", name: "base", version: "1.0.5.1" });
  });
});
