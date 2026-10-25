// 更新检查的双源：GitHub API 与 Gitee 分支 API 形状不同，回退那一路必须真能取到 sha。
// 真事故（2026-10-25）：Gitee 分支接口给的是 commit.sha，代码只读 commit.id →
// 备用源永远拿不到 sha，"双源回退"名存实亡；那天恰好 GitHub API 通，所以一直没暴露。
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { checkUpdate } from "../../engine/system-panel.mjs";

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "update-"));
fs.writeFileSync(path.join(repo, "version.json"), JSON.stringify({ version: "9.9.9" }), "utf8");

// 假的 git：仓库里没有 .git，checkUpdate 会回落到 build 标记
const git = () => ({ ok: false, code: 128 });

const giteeBody = {
  name: "main",
  commit: {
    sha: "1fbb0e99383f967a15a4fb9f8a506e93bd4475f9",
    commit: { message: "chore(release): 2.128.0\n\n正文", committer: { date: "2026-10-25T08:12:00+08:00" } },
  },
};

test("Gitee 分支接口（commit.sha）能被正确解析出短 sha 与提交时间", async () => {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    if (url.includes("gitee.com")) return { ok: true, json: async () => giteeBody };
    return { ok: false, status: 503, json: async () => ({}) };   // GitHub 不通 → 走回退
  };
  const out = await checkUpdate(repo, fs, { fetchImpl, git });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.source, "gitee", "GitHub 挂了就该用 Gitee");
  assert.equal(out.remote.sha, "1fbb0e9");
  assert.equal(out.remote.message, "chore(release): 2.128.0", "只取标题行");
  assert.ok(out.remote.date, "必须带上提交时间，否则时间判先后的那支会失真");
  assert.ok(fetched.some((u) => u.includes("gitee.com")), "确实请求过 gitee");
});

test("两个源都不可用时不假装最新", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const out = await checkUpdate(repo, fs, { fetchImpl, git });
  assert.equal(out.ok, false);
  assert.match(out.error, /无法连接/);
});
