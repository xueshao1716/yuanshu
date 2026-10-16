import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WORKSPACE_DIRNAME = 'yuanshu-space';
export const LEGACY_WORKSPACE_DIRNAME = 'pi-workspace';

const defaultIsDirectory = candidate => {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
};

// 候选目录，按优先级：每个位置先认新名 yuanshu-space，再认老名 pi-workspace（老用户数据不搬家）。
export function workspaceCandidates({ platform = process.platform, home = os.homedir() } = {}) {
  const roots = platform === 'win32' ? ['D:\\', 'E:\\', 'C:\\', home] : [home];
  return roots.flatMap(root => [WORKSPACE_DIRNAME, LEGACY_WORKSPACE_DIRNAME].map(name => path.join(root, name)));
}

// Keep the service and standalone runners on the same deployed workspace.
// The probe is injectable so precedence can be tested without touching a real workspace.
export function defaultWorkspace({ platform = process.platform, home = os.homedir(), isDirectory = defaultIsDirectory } = {}) {
  return workspaceCandidates({ platform, home }).find(isDirectory) || path.join(home, WORKSPACE_DIRNAME);
}

// 与 defaultWorkspace 同序，但全都不存在时返回 null（调用方自己决定兜底，例如启动目录）。
export function existingWorkspace(opts = {}) {
  const { platform = process.platform, home = os.homedir(), isDirectory = defaultIsDirectory } = opts;
  return workspaceCandidates({ platform, home }).find(isDirectory) || null;
}

// 环境变量：新名 YUANSHU_WORKSPACE，老名 PI_WORKSPACE 仍认。
export const workspaceFromEnv = (env = process.env) => env.YUANSHU_WORKSPACE || env.PI_WORKSPACE || '';
