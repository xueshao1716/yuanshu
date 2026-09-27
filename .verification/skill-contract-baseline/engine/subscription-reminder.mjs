import fs from "node:fs";

/** Read the subscription tracking file only when the path is a regular file. */
export function readSubscriptionText(file, fsImpl = fs) {
  try {
    if (!fsImpl.existsSync(file) || !fsImpl.statSync(file).isFile()) return "";
    return fsImpl.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
