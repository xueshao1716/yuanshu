import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { executeShareProject } from "../../engine/tools/unified-tools.mjs";

test("share_project refuses an unconfigured host before copying files", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "yuanshu-share-unconfigured-"));
  try {
    await fsp.writeFile(path.join(root, "page.html"), "<h1>private</h1>");
    const result = await executeShareProject({ path: "page.html" }, {
      cwd: root, agentDir: root, host: '', isPortOpen: async () => true,
    });
    assert.equal(result.isError, true);
    assert.ok(result.text.includes('分享域名'));
    assert.equal(fs.existsSync(path.join(root, "外网分享")), false);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test("share_project copies a nested project without the Windows cpSync crash path", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "yuanshu-share-"));
  const source = path.join(root, "source-project");
  const shareDir = path.join(root, "published");
  try {
    await fsp.mkdir(path.join(source, "assets", "img"), { recursive: true });
    await fsp.writeFile(path.join(source, "index.html"), "<h1>ok</h1>");
    await fsp.writeFile(path.join(source, "assets", "img", "hero.jpg"), Buffer.from([0, 1, 2, 3, 4]));

    const result = await executeShareProject(
      { path: "source-project" },
      { cwd: root, shareDir, isPortOpen: async () => true, host: "example.test" },
    );

    assert.equal(result.isError, false);
    assert.match(result.text, /https:\/\/example\.test\/source-project\//);
    assert.equal(await fsp.readFile(path.join(shareDir, "source-project", "index.html"), "utf8"), "<h1>ok</h1>");
    assert.deepEqual(
      [...fs.readFileSync(path.join(shareDir, "source-project", "assets", "img", "hero.jpg"))],
      [0, 1, 2, 3, 4],
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
