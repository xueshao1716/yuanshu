import test from "node:test";
import assert from "node:assert/strict";
import { frontendVersionPayload, versionStamp } from "../../engine/frontend-version.mjs";

test("前端版本戳由产品 semver 单调派生", () => {
  assert.equal(versionStamp("2.112.0"), 2_112_000);
  assert.ok(versionStamp("2.112.1") > versionStamp("2.112.0"));
  assert.equal(versionStamp("unknown"), 0);
});

test("hash 产物没有 ?v= 时，更新接口仍返回当前版本而不是 0", () => {
  assert.deepEqual(frontendVersionPayload({
    appVersion: "2.112.0",
    html: '<script src="./assets/index-abc.js"></script>',
  }), { version: 2_112_000, appVersion: "2.112.0" });
});

test("旧 query 版本戳仍被兼容且不会压低产品版本", () => {
  assert.deepEqual(frontendVersionPayload({
    appVersion: "2.112.0",
    html: '<script src="./app.js?v=3000000"></script>',
  }), { version: 3_000_000, appVersion: "2.112.0" });
});
