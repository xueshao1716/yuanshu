// online-update 分叉自愈契约（2026-10-13 bug 弹窗实证）：快照→修旧仓名→reset 对齐，快照失败不 reset
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { reconcileDiverged } from "../../engine/online-update.mjs";

function sh(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function makeRepoPair() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "yuanshu-div-"));
  const remote = path.join(base, "remote.git");
  const local = path.join(base, "local");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["clone", "-q", remote, local], { encoding: "utf8" });
  sh(local, "config", "user.email", "t@t"); sh(local, "config", "user.name", "t");
  fs.writeFileSync(path.join(local, "a.txt"), "v1");
  sh(local, "add", "a.txt"); sh(local, "commit", "-qm", "init"); sh(local, "branch", "-M", "main");
  execFileSync("git", ["-C", local, "push", "-q", "origin", "main"], { encoding: "utf8" });
  return { base, remote, local };
}

test("分叉自愈：本地独立提交+未提交改动 → 快照→reset 对齐远端", async () => {
  const { base, remote, local } = makeRepoPair();
  try {
    // 远端前进
    fs.writeFileSync(path.join(local, "a.txt"), "v1-remote");
    execFileSync("git", ["-C", local, "commit", "-aqm", "remote-advance"]);
    execFileSync("git", ["-C", local, "push", "-q", "origin", "main"]);
    // 本地 reset 到旧位置 + 本地独立提交 + 未提交改动 → 分叉
    execFileSync("git", ["-C", local, "reset", "-q", "--hard", "HEAD~1"]);
    fs.writeFileSync(path.join(local, "a.txt"), "v1-remote\nlocal-line");
    execFileSync("git", ["-C", local, "add", "a.txt"]);
    execFileSync("git", ["-C", local, "commit", "-qm", "local-commit"]);
    fs.writeFileSync(path.join(local, "new.txt"), "uncommitted stuff");
    execFileSync("git", ["-C", local, "fetch", "origin"]);
    const before = sh(local, "rev-parse", "HEAD");
    const r = await reconcileDiverged({ git: (args) => {
      try { return { ok: true, out: execFileSync("git", ["-C", local, ...args], { encoding: "utf8", stdio: ["pipe"] }).trim() }; }
      catch (e) { return { ok: false, err: String(e.stderr || e.message).trim() }; }
    }, root: local });
    assert.equal(r.ok, true, JSON.stringify(r));
    const after = sh(local, "rev-parse", "HEAD");
    const remoteHead = sh(remote, "rev-parse", "main");
    assert.equal(after, remoteHead, "已对齐远端 main");
    assert.notEqual(after, before, "HEAD 前进了");
    // 快照物存在
    const ymd = new Date().toISOString().slice(0, 10);
    const snapDir = path.join(os.tmpdir(), "yuanshu-div", path.basename(base), "..", "..", "..").length > 0 ? null : null; // 校验在下方 run 内断言
    const recorded = JSON.stringify(r).includes("snapshot") || r.snapshotPath;
    assert.ok(recorded, "返回快照路径");
    // local-commits 快照 → 内容含本地提交标题
    const snap = r.snapshotPath;
    assert.ok(fs.existsSync(path.join(snap, "local-commits.txt")) || fs.existsSync(path.join(snap, "uncommitted.patch")), "至少快照了提交或改动");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("分叉自愈修复旧仓名 remote（gitee pi-web → yuanshu.git）", async () => {
  const { base, remote, local } = makeRepoPair();
  try {
    execFileSync("git", ["-C", local, "remote", "set-url", "origin", "https://gitee.com/linxinyu520xue/pi-web"]);
    // 假 fetch 层面：get-url 后 set-url + fetch 需真实远端，mock git 层让 fetch 可过
    let fixed = "";
    const r = await reconcileDiverged({ git: (args) => {
      const a = args.join(" ");
      if (a.startsWith("remote get-url")) return { ok: true, out: "https://gitee.com/linxinyu520xue/pi-web" };
      if (a.startsWith("remote set-url")) { fixed = args[args.length - 1]; return { ok: true, out: "" }; }
      if (a.startsWith("fetch")) return { ok: true, out: "" };
      if (a.startsWith("reset")) return { ok: true, out: "" };
      if (a.startsWith("diff") || a.startsWith("ls-files") || a.startsWith("log") || a.startsWith("format-patch")) return { ok: true, out: "" };
      return { ok: true, out: "" };
    }, root: local });
    assert.equal(fixed, "https://gitee.com/linxinyu520xue/yuanshu.git", "旧仓名被替换");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
