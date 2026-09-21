#!/usr/bin/env node
// 发版：一条命令同步所有版本声明 + 收 CHANGELOG。
//
//   npm run version:bump patch     # 2.8.0 → 2.8.1
//   npm run version:bump minor     # 2.8.0 → 2.9.0
//   npm run version:bump major     # 2.8.0 → 3.0.0
//   npm run version:bump 3.1.4     # 直接指定
//   npm run version:bump sync      # 把所有声明对齐到 version.json（不递增、不动 CHANGELOG）
//   npm run version:bump minor --dry   # 只看会改什么，不落盘
//
// 为什么需要它：版本号此前散在 9 个文件里各写各的，两条线（产品 2.7.1 / 壳 0.2.4）
// 互不相干，壳版本甚至倒退过一次，而且没有任何机制强制推进——2026-09-12 到 09-14
// 发了一整批功能，一个号都没动。手工同步 9 处必然漏，所以做成脚本 + 契约测试兜底。
//
// 契约文档：docs/NAMING.md    漂移检测：tests/unit/naming-contract.test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "version.json");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");

// 每一处版本声明。re 的第二个捕获组必须是版本字符串本身。
// ⚠️ engine/mcp-server.mjs 里还有 protocolVersion（MCP 协议版本，如 2024-11-05），
//    那是**协议**的版本不是我们的，所以这里用精确到 serverInfo 的正则，绝不误伤。
const TARGETS = [
  { file: "version.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "package.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "app/package.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "frontend/package.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "mcp-server/package.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "app/src-tauri/tauri.conf.json", re: /("version"\s*:\s*")([^"]+)(")/ },
  { file: "app/src-tauri/Cargo.toml", re: /(^version\s*=\s*")([^"]+)(")/m },
  { file: "mcp-server/index.mjs", re: /(\bversion:\s*")([^"]+)(")/ },
  { file: "engine/mcp-server.mjs", re: /(serverInfo:\s*\{\s*name:\s*"yuanshu \(元枢\)",\s*version:\s*")([^"]+)(")/ },
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function readVersion() {
  try {
    const v = String(JSON.parse(fs.readFileSync(VERSION_FILE, "utf8")).version || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(v)) fail(`version.json 里的版本号不合法: "${v}"`);
    return v;
  } catch (e) {
    fail(`读不到 ${VERSION_FILE}: ${e.message}`);
  }
}

function nextVersion(current, arg) {
  if (arg === "sync") return current;
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg;
  const [major, minor, patch] = current.split(".").map(Number);
  if (arg === "major") return `${major + 1}.0.0`;
  if (arg === "minor") return `${major}.${minor + 1}.0`;
  if (arg === "patch") return `${major}.${minor}.${patch + 1}`;
  fail(`用法: version:bump <major|minor|patch|x.y.z|sync>，收到 "${arg}"`);
}

const args = process.argv.slice(2).filter(a => a !== "--dry");
const dry = process.argv.includes("--dry");
const bump = args[0];
if (!bump) fail("用法: version:bump <major|minor|patch|x.y.z|sync>");

const current = readVersion();
const isSync = bump === "sync";
const next = nextVersion(current, bump);
if (next === current && !isSync) fail(`新版本与当前一致（${current}），没有要改的。要对齐各处声明请用 version:bump sync`);

console.log(`\n${isSync ? `对齐所有声明到 ${next}` : `版本 ${current} → ${next}`}${dry ? "（--dry 预演，不落盘）" : ""}\n`);

const results = [];
for (const { file, re } of TARGETS) {
  const full = path.join(ROOT, file);
  let text;
  try { text = fs.readFileSync(full, "utf8"); }
  catch (e) { fail(`读不到 ${file}: ${e.message}`); }
  const m = text.match(re);
  if (!m) fail(`${file} 里找不到版本声明——契约变了？请同步更新 scripts/bump-version.mjs`);
  if (m[2] === next) { results.push({ file, from: m[2], changed: false }); continue; }
  const updated = text.replace(re, (_all, pre, _old, post) => `${pre}${next}${post}`);
  if (!dry) fs.writeFileSync(full, updated, "utf8");
  results.push({ file, from: m[2], changed: true });
}

// 锁文件只同步根包声明；不刷新依赖、不联网、不改第三方版本。
for (const file of ['package-lock.json', 'frontend/package-lock.json', 'app/package-lock.json', 'mcp-server/package-lock.json']) {
  const full = path.join(ROOT, file);
  const raw = fs.readFileSync(full, 'utf8');
  const data = JSON.parse(raw);
  const from = data.version;
  const rootPackage = data.packages?.[''];
  if (!rootPackage) fail(`${file} 缺少根包`);
  const updated = JSON.stringify({ ...data, version: next, packages: { ...data.packages, '': { ...rootPackage, version: next } } }, null, 2) + '\n';
  // Validate dependencies before writing.
  const parsed = JSON.parse(updated);
  if (parsed.packages[''].version !== next) fail(`${file} 根包版本未匹配`);
  for (const [name, item] of Object.entries(data.packages)) {
    if (name && JSON.stringify(item) !== JSON.stringify(parsed.packages[name])) fail(`${file} 意外触及依赖 ${name}`);
  }
  if (!dry) fs.writeFileSync(full, updated, 'utf8');
  results.push({ file, from, changed: updated !== raw });
}
{
  const file = 'app/src-tauri/Cargo.lock', full = path.join(ROOT, file);
  const raw = fs.readFileSync(full, 'utf8');
  const re = /(\[\[package\]\]\r?\nname = "yuanshu"\r?\nversion = ")[^"]+("\r?\n)/;
  if (!re.test(raw)) fail(`${file} 找不到元枢根包`);
  const updated = raw.replace(re, (_all, pre, post) => `${pre}${next}${post}`);
  if (!dry) fs.writeFileSync(full, updated, 'utf8');
  results.push({ file, from: current, changed: updated !== raw });
}

// CHANGELOG：把 [Unreleased] 收成正式版本，并留一个空的 [Unreleased] 在上面。
// sync 只做对齐，不代表发版，所以不动 CHANGELOG。
const today = new Date().toISOString().slice(0, 10);
if (isSync) {
  // 对齐不碰 CHANGELOG
} else {
  let changelog = fs.readFileSync(CHANGELOG, "utf8");
  const unreleasedRe = /^## \[Unreleased\][^\n]*$/m;
  if (unreleasedRe.test(changelog)) {
    changelog = changelog.replace(unreleasedRe, `## [Unreleased]\n\n## [${next}] - ${today}`);
  } else {
    // 自愈：收版时若忘了留 [Unreleased]，下一次 bump 就会无处可收。
    // 直接在最新版本条目上方补一个空的，别让契约烂在这里。
    const firstVersionRe = /^## \[/m;
    if (!firstVersionRe.test(changelog)) fail("CHANGELOG.md 里既没有 ## [Unreleased] 也没有任何 ## [x.y.z] 条目");
    changelog = changelog.replace(firstVersionRe, `## [Unreleased]\n\n## [${next}] - ${today}\n\n## [`);
    console.log("⚠️ CHANGELOG.md 原本没有 ## [Unreleased]，已自动补上并收版");
  }
  if (!dry) fs.writeFileSync(CHANGELOG, changelog, "utf8");
  results.push({ file: "CHANGELOG.md", from: "## [Unreleased]", changed: true });
}

for (const r of results) {
  console.log(`  ${r.changed ? "改" : "同"}  ${r.file.padEnd(32)} ${r.from} → ${r.changed ? next : "(已是)"}`);
}

console.log(`\n${dry ? "预演完成，未改动任何文件。" : `完成。下一步：补 CHANGELOG 条目 → 构建前端 → 双推（当前版本会在产物名里体现为 v${next}）。`}\n`);
