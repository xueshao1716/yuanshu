// engine/runtime-env.mjs —— 告诉模型"自己在什么系统上、用什么符号"（2026-10-24）
//
// 起因：模型把 `/d/pi-web`（bash 路径）和 `D:\pi-web`（Windows 路径）混着用，
// 还拿 bash 命令去扫只该用 read 的大目录，一条 grep 把事件循环占了 5 分钟。
// 工具描述里虽然写了 shell，但那是"工具说明"，不是"环境事实"。这里做成常驻事实段，
// 每轮都在，且**按真实探测结果生成**，不是写死的。
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const GIT_ROOT_HINTS = [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git'),
  path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git'),
];

let _cached = null;

function detectShell() {
  if (process.platform !== 'win32') return { kind: 'posix', label: process.env.SHELL || '/bin/sh' };
  // 与 unified-tools 的探测保持一致：优先真正的 bash 本体（usr\bin\bash.exe），不认 WSL 启动器
  for (const root of GIT_ROOT_HINTS) {
    for (const rel of ['usr\\bin\\bash.exe', 'bin\\bash.exe']) {
      const p = path.join(root, rel);
      try {
        if (fs.existsSync(p)) return { kind: 'git-bash', label: p };
      } catch {}
    }
  }
  // 元枢安装包自带的 git（runtime/git），服务身份下也在
  const bundled = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Yuanshu', 'runtime', 'git', 'usr', 'bin', 'bash.exe');
  try {
    if (fs.existsSync(bundled)) return { kind: 'git-bash', label: bundled };
  } catch {}
  return { kind: 'cmd', label: process.env.ComSpec || 'cmd.exe' };
}

export function runtimeEnvironmentFacts() {
  if (_cached) return _cached;
  const shell = detectShell();
  const platform = `${os.type()} ${os.release()} (${process.arch})`;
  const facts = {
    platform,
    node: process.version,
    shellKind: shell.kind,
    shellPath: shell.label,
    cwd: process.cwd(),
    isWindows: process.platform === 'win32',
  };
  _cached = facts;
  return facts;
}

/** 生成可注入 system prompt 的「运行环境」段：只讲事实与怎么用，避免模型瞎猜 */
export function environmentSection() {
  const f = runtimeEnvironmentFacts();
  const lines = [];
  lines.push(`【运行环境】系统：${f.platform}；Node ${f.node}；工作目录：${f.cwd}`);
  if (f.shellKind === 'git-bash') {
    lines.push(`命令工具跑的是 **git-bash（真 bash，MINGW64）**，不是 cmd、不是 WSL：${f.shellPath}`);
    lines.push('路径写法（同一条命令里可以混用，但要写成同一种）：bash 风格 `/d/pi-web/engine`，或 Windows 风格 `D:/pi-web/engine`（正斜杠）。**不要**写成 `/mnt/d/...`（那是 WSL，会找不到）。');
    lines.push('可用命令：ls / grep / find / sed / cat / curl / node / python 都在；**没有** cmd 内建（dir、type、findstr、copy），要用 bash 等价物。');
    lines.push('搜代码时给 grep 加范围与排除：`grep -rn --include="*.mjs" --exclude-dir=node_modules --exclude-dir=dist 关键词 engine/`。**不要**递归扫整个项目根或 app/（含构建产物，会跑几分钟并被超时杀掉）。');
  } else if (f.shellKind === 'cmd') {
    lines.push(`命令工具跑的是 **cmd.exe**：${f.shellPath}`);
    lines.push('路径用反斜杠 `D:\\pi-web`；命令是 cmd 内建或 exe（dir / type / findstr / copy），**没有** grep / ls / sed。搜代码请用 `findstr /s /n /i "关键词" engine\\*.mjs`。');
  } else {
    lines.push(`命令工具跑的是 POSIX shell：${f.shellPath}`);
  }
  lines.push('工具参数（read / write / edit / 各种 path 字段）一律用 **Windows 绝对路径**（`D:\\pi-web\\engine\\x.mjs`）或相对工作目录的路径；只有 bash 命令字符串里才用 bash 路径写法。');
  lines.push('任何"这个系统上有没有某命令/某路径"的判断，先探测（`command -v x`、`ls`、`node -v`）再断言，不要凭印象。');
  return lines.join('\n');
}
