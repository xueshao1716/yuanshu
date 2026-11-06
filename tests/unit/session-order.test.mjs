import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareSessionTimes,
  initSessionFiles,
  getSessionList,
  invalidateSessionCache,
} from "../../engine/session/files.mjs";
import { ensureSessionSequence, handleDbList, initSessionDb } from "../../engine/session/db.mjs";

function sessionFile(dir, id, created, events = []) {
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: "session", id, timestamp: created, cwd: dir },
    { type: "session_info", name: id },
    ...events.map(timestamp => ({ type: "message", timestamp, message: { role: "user", content: timestamp } })),
  ];
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

function captureJson() {
  let body = "";
  return {
    res: {
      writeHead() {},
      end(value) { body = String(value || ""); },
    },
    read() { return JSON.parse(body); },
  };
}

test("会话列表使用可比较的时间排序，不能按 ISO 字符串字典序误排", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-order-"));
  try {
    const sessions = path.join(root, "sessions");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(sessions);
    fs.mkdirSync(workspace);
    sessionFile(sessions, "older", "2026-09-02T23:59:00.000Z", ["2026-09-10T10:00:00+02:00"]);
    sessionFile(sessions, "newer", "2026-09-10T08:00:00.000Z", ["2026-09-10T09:00:00Z"]);
    initSessionFiles({ sessionsDir: sessions, workspaceCwd: workspace });
    invalidateSessionCache();
    assert.deepEqual(getSessionList().map(s => s.id), ["newer", "older"]);
    assert.ok(compareSessionTimes({ updatedAt: "2026-09-10T10:00:00+02:00" }, { updatedAt: "2026-09-10T09:00:00.000Z" }) > 0);
  } finally {
    invalidateSessionCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("会话数据库首次读取自动分配持久编号，不需要手动重建索引", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-session-seq-"));
  try {
    const sessions = path.join(root, "sessions");
    const workspace = path.join(root, "workspace");
    const agentDir = path.join(root, "agent");
    fs.mkdirSync(sessions);
    fs.mkdirSync(workspace);
    fs.mkdirSync(agentDir);
    sessionFile(sessions, "old", "2026-09-01T00:00:00.000Z", ["2026-09-01T00:01:00.000Z"]);
    sessionFile(sessions, "new", "2026-09-02T00:00:00.000Z", ["2026-09-02T00:01:00.000Z"]);
    initSessionFiles({ sessionsDir: sessions, workspaceCwd: workspace });
    invalidateSessionCache();
    initSessionDb({ agentDir, cwd: workspace });

    const first = captureJson();
    handleDbList(first.res);
    const listed = first.read().sessions;
    assert.deepEqual(listed.map(s => s.id), ["new", "old"]);
    assert.deepEqual(Object.fromEntries(listed.map(s => [s.id, s.seq])), { old: 1, new: 2 });
    assert.ok(fs.existsSync(path.join(agentDir, "session-db.json")));
    assert.equal(ensureSessionSequence("created-after-open"), 3);

    const second = captureJson();
    handleDbList(second.res);
    assert.deepEqual(Object.fromEntries(second.read().sessions.map(s => [s.id, s.seq])), { old: 1, new: 2 });
    const persisted = JSON.parse(fs.readFileSync(path.join(agentDir, "session-db.json"), "utf8"));
    assert.equal(persisted.seqMap["created-after-open"], 3);
  } finally {
    invalidateSessionCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
