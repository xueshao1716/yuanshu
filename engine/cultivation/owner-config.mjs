import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readOwnerCredential} from './owner-webauthn.mjs';

// Read-only host deployment boundary. HTTP and model APIs cannot enroll keys.
// 凭据文件布局：Windows = %LOCALAPPDATA%\Yuanshu\owner-confirmation\<workspace>.json
//              Linux/mac = $XDG_CONFIG_HOME(~/.config)/Yuanshu/owner-confirmation/<workspace>.json
// 文件必须带外投放（HTTP/模型接口不能注册密钥）；读取时的符号链接/硬链接/大小检查两端一致。
function credentialRoot({env, platform}) {
  if (platform === 'win32') return env.LOCALAPPDATA || '';
  return env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

export function ownerConfigProvider({workspace, env = process.env, platform = process.platform}) {
  const root = credentialRoot({env, platform});
  if (!root || !path.isAbsolute(root) || !/^[a-f0-9]{64}$/.test(workspace)) return () => null;
  const dir = path.join(root, 'Yuanshu', 'owner-confirmation');
  const file = path.join(dir, workspace + '.json');
  return () => {
    try {
      for (const entry of [root, path.join(root, 'Yuanshu'), dir, file]) {
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) throw new Error('unsafe_owner_path');
        if (entry === file && (!stat.isFile() || stat.nlink !== 1 || stat.size > 10000)) throw new Error('unsafe_owner_file');
      }
      return readOwnerCredential(JSON.parse(fs.readFileSync(file, 'utf8')), workspace);
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('cultivation_identity_unavailable'); }
  };
}
