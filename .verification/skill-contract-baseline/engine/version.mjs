// 版本与命名的唯一来源。
//
// 为什么要有这个文件：在此之前版本号散在 6 个地方各写各的——
//   package.json / app/package.json / tauri.conf.json / Cargo.toml = 0.2.4（壳版本）
//   engine/unified-chat.mjs 的 APP_VERSION                          = 2.7.1（产品版本）
//   frontend/package.json                                          = 1.0.0（从没动过）
// 两条线互不相干，壳版本甚至倒退过一次（1.0.0 → 0.2.2），而且没有任何机制强制推进：
// 2026-09-12 到 09-14 之间发了一整批功能，两个号一个都没动。界面还把两个都叫「版本」，
// 用户在系统页看到 v0.2.4、在看板看到 2.7.1，自然觉得"版本号一直不动"。
//
// 现在：version.json 是唯一来源，其余全部由它派生或被测试钉死（见 tests/unit/naming-contract.test.mjs）。
// 发版只跑 `npm run version:bump <major|minor|patch>`，它会同时改所有声明并收 CHANGELOG。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VERSION_FILE = path.join(HERE, "..", "version.json");

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
    const version = String(raw?.version || "").trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) return null;
    return { version, product: String(raw.product || "元枢"), productEn: String(raw.productEn || "Yuanshu") };
  } catch {
    return null;
  }
}

// 读不到也不能让服务起不来：退回一个明确的占位值，比抛异常炸掉整个进程好。
// 但占位值格式非法（含 ???），命名契约测试会当场抓住，不会被悄悄带进产物名。
const FALLBACK = { version: "0.0.0-unknown", product: "元枢", productEn: "Yuanshu" };

export const META = read() || FALLBACK;

/** 产品版本，例如 "2.8.0"。所有对外展示与产物命名都用它。 */
export const PRODUCT_VERSION = META.version;

/** 产品名，例如 "元枢"。 */
export const PRODUCT_NAME = META.product;

/** 产物名里的版本段，例如 "v2.8.0"。 */
export const VERSION_TAG = `v${PRODUCT_VERSION}`;
