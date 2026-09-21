import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the service and standalone runners on the same deployed workspace.
// The probe is injectable so precedence can be tested without touching a real workspace.
export function defaultWorkspace({ platform = process.platform, home = os.homedir(), isDirectory = candidate => {
  try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
} } = {}) {
  const candidates = platform === 'win32'
    ? ['D:\\pi-workspace', 'E:\\pi-workspace', 'C:\\pi-workspace', path.join(home, 'pi-workspace')]
    : [path.join(home, 'pi-workspace')];
  return candidates.find(isDirectory) || path.join(home, 'pi-workspace');
}
