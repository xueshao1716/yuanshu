// 导入预检的单元测试：用临时目录造"假模块"，不碰仓库真实代码。
// 覆盖：正常通过、缺文件、缺符号（2026-11-10 事故）、default 不误报、
//       node:/第三方跳过、递归两层、export * 不误报、加载失败不外抛。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preflightImports } from "../../scripts/lib/import-preflight.mjs";

const tempDirs = [];

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ys-preflight-"));
  tempDirs.push(dir);
  for (const [rel, source] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return dir;
}

const preflight = (dir, extra = {}) => preflightImports({ root: dir, entry: "server.mjs", timeoutMs: 10000, ...extra });

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

test("正常通过：具名导出齐全，含间接依赖", async () => {
  const dir = fixture({
    "server.mjs": `import { greet } from "./lib/greet.mjs";\nimport "./lib/side-effect.mjs";\nconsole.log(greet("x"));\n`,
    "lib/greet.mjs": `export { hello } from "./hello.mjs";\nexport function greet(name) { return hello(name); }\n`,
    "lib/hello.mjs": `export const hello = (name) => "hi " + name;\n`,
    "lib/side-effect.mjs": `globalThis.__preflightSideEffect = true;\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 3);
  assert.deepEqual(result.issues, []);
  assert.equal(result.timedOut, false);
});

test("缺文件：报 missing-file 并带导入方", async () => {
  const dir = fixture({
    "server.mjs": `import { x } from "./lib/forgot-to-copy.mjs";\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.kind === "missing-file");
  assert.ok(issue, "应报 missing-file");
  assert.equal(issue.target, "lib/forgot-to-copy.mjs");
  assert.equal(issue.from, "server.mjs");
  assert.deepEqual(issue.symbols, ["x"]);
});

test("缺符号：复现 does not provide an export named 那起事故", async () => {
  const dir = fixture({
    "server.mjs": `import { failureAttribution } from "./engine/failure-ledger.mjs";\n`,
    "engine/failure-ledger.mjs": `export function recordFailure() {}\nexport const failureLedger = { version: 1 };\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.kind === "missing-export");
  assert.ok(issue, "应报 missing-export");
  assert.equal(issue.target, "engine/failure-ledger.mjs");
  assert.equal(issue.from, "server.mjs");
  assert.deepEqual(issue.symbols, ["failureAttribution"]);
  assert.match(issue.hint, /failureAttribution/);
});

test("default 导入不误报（记 unknown）", async () => {
  const dir = fixture({
    "server.mjs": `import ledger from "./engine/failure-ledger.mjs";\nconsole.log(ledger);\n`,
    "engine/failure-ledger.mjs": `export const failureLedger = { version: 1 };\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
  assert.ok(
    result.unknowns.some((u) => u.target === "engine/failure-ledger.mjs" && /default/.test(u.reason)),
    "default 应被标为 unknown",
  );
});

test("node: 内置与第三方裸导入跳过", async () => {
  const dir = fixture({
    "server.mjs": `import fs from "node:fs";\nimport path from "node:path";\nimport express from "express";\nimport { helper } from "./helper.mjs";\nconsole.log(fs, path, express, helper);\n`,
    "helper.mjs": `export const helper = 1;\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 1);
  assert.deepEqual(result.issues, []);
  assert.equal(result.unknowns.filter((u) => /express|node:/.test(u.target)).length, 0);
});

test("递归两层：深层模块缺符号也能抓到", async () => {
  const dir = fixture({
    "server.mjs": `import { topLevel } from "./a.mjs";\n`,
    "a.mjs": `import { middle } from "./b.mjs";\nexport const topLevel = 1;\n`,
    "b.mjs": `import { deep } from "./c.mjs";\nexport const middle = 2;\n`,
    "c.mjs": `export const somethingElse = 3;\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, false);
  assert.equal(result.checked, 3);
  const deep = result.issues.find((i) => i.kind === "missing-export" && i.target === "c.mjs");
  assert.ok(deep, "两层之外（a → b → c）的缺符号应被发现");
  assert.deepEqual(deep.symbols, ["deep"]);
  assert.equal(deep.from, "b.mjs");
});

test("export * 不误报：运行时命名空间能解析出符号", async () => {
  const dir = fixture({
    "server.mjs": `import { foo } from "./barrel.mjs";\nconsole.log(foo);\n`,
    "barrel.mjs": `export * from "./impl.mjs";\n`,
    "impl.mjs": `export const foo = 42;\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.unknowns.some((u) => u.target === "impl.mjs" && u.from === "barrel.mjs" && /export \*/.test(u.reason)),
    "export * 边应标 unknown",
  );
});

test("加载失败：记 load-error，preflight 本身不外抛", async () => {
  const dir = fixture({
    "server.mjs": `import "./boom.mjs";\n`,
    "boom.mjs": `throw new Error("boom-top-level");\n`,
  });
  const result = await preflight(dir);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.kind === "load-error");
  assert.ok(issue, "应报 load-error");
  assert.equal(issue.target, "boom.mjs");
  assert.match(issue.hint, /boom-top-level/);
});
