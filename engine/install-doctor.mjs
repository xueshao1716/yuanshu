// 环境体检：装完（或换机后）一眼看清各组件是否就位。
// 每项给 ok / warn / fail + 一句人话说明；不修改任何东西，只读探测。
// 探测函数可注入，单测不碰真机环境。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

function runDefault(cmd, args, { timeout = 15000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, encoding: 'utf8', env: env || process.env }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || '').trim(), err: String(stderr || err?.message || '').trim() });
    });
  });
}

const firstLine = (s) => String(s || '').split(/\r?\n/)[0].slice(0, 120);
// 版本号只留 a.b.c：5.1.22621.4249 这种对用户没意义
const shortVer = (s) => String(firstLine(s) || '').split('.').slice(0, 3).join('.');
// 基本盘只查安装包自带的库；pandas/PDF/抠图/ffmpeg 属于可选组件，由 addons.mjs 列出与安装
const PY_CHECK = 'import importlib,json;m=["pptx","docx","openpyxl","PIL","edge_tts"];r={};\nfor n in m:\n  try: importlib.import_module(n); r[n]=True\n  except Exception: r[n]=False\nprint(json.dumps(r))';

export async function runDoctor({ wsRoot, agentDir, piPackage, bashPath, port, run = runDefault, fsMod = fs, platform = process.platform } = {}) {
  const items = [];
  const add = (key, label, status, detail) => items.push({ key, label, status, detail });

  add('node', 'Node.js', 'ok', `${process.version}（${firstLine(process.execPath)}）`);

  // 工作区与人格
  try {
    fsMod.mkdirSync(wsRoot, { recursive: true });
    const probe = path.join(wsRoot, `.doctor-${process.pid}`);
    fsMod.writeFileSync(probe, 'ok'); fsMod.rmSync(probe, { force: true });
    add('workspace', '工作区', 'ok', wsRoot);
  } catch (e) { add('workspace', '工作区', 'fail', `不可写：${wsRoot}（${e?.code || e?.message || e}）`); }
  const persona = path.join(String(wsRoot || ''), '记忆', '人格定义.json');
  const genome = path.join(String(wsRoot || ''), '工程', '经验库', 'genome.json');
  add('persona', '人格与基因', fsMod.existsSync(persona) && fsMod.existsSync(genome) ? 'ok' : 'warn',
    fsMod.existsSync(persona) ? (fsMod.existsSync(genome) ? '人格定义与基因基线都在' : '缺基因基线，将使用内置默认值') : '缺人格定义，将使用内置默认人格');

  // 模型服务：有 key 才能聊天
  let keys = 0;
  try {
    const auth = JSON.parse(fsMod.readFileSync(path.join(agentDir, 'auth.json'), 'utf8'));
    keys = Object.values(auth || {}).filter((v) => v && (typeof v === 'string' ? v.trim() : v.key || v.apiKey || v.access)).length;
  } catch {}
  add('models', '模型服务', keys > 0 ? 'ok' : 'fail', keys > 0 ? `已配置 ${keys} 个服务` : '还没有配置模型服务的 API Key，到「模型」页添加');

  add('pi', '兼容适配器', piPackage && fsMod.existsSync(piPackage) ? 'ok' : 'warn', piPackage && fsMod.existsSync(piPackage) ? '已就位' : '未找到（可选，不影响核心功能）');

  const dsh = platform === 'win32'
    ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'dsh --version'], { timeout: 10000 })
    : await run('dsh', ['--version'], { timeout: 10000 });
  add('dsh', 'dsh 引擎', dsh.ok ? 'ok' : 'warn', dsh.ok ? firstLine(dsh.out) : '未找到（可选）');

  const py = await run('python', ['-c', PY_CHECK], { timeout: 30000 });
  if (!py.ok) add('python', 'Python', 'warn', '未找到 Python：运行代码、文档/表格/PPT 处理会受限');
  else {
    let mods = {};
    try { mods = JSON.parse(py.out.split(/\r?\n/).pop()); } catch {}
    const missing = Object.entries(mods).filter(([, v]) => !v).map(([k]) => k);
    add('python', 'Python 与常用库', missing.length ? 'warn' : 'ok', missing.length ? `缺少：${missing.join('、')}` : '文档/表格/PPT/图片/语音库齐全');
  }

  const git = await run('git', ['--version'], { timeout: 10000 });
  add('git', 'Git', git.ok ? 'ok' : 'warn', git.ok ? firstLine(git.out) : '未找到：版本管理与检测更新不可用');

  // 2026-10-27：用户看不懂"bash / git-bash"这套说法，而且这台机器上模型用的是 PowerShell。
  // 所以这里改成查「命令工具」实际有哪些，并按可用性给结论——不装 git-bash 也不算问题。
  let pwshVer = '';
  let ps5Ver = '';
  if (platform === 'win32') {
    // 2026-10-27：PowerShell 7 不随 Windows 附带，可以是「用户目录免管理员安装」。
    // 服务以 SYSTEM 运行，看不到用户 PATH，所以要显式探这几个位置。
    const userPwsh = [];
    // 扫所有用户目录（服务是 SYSTEM，自己的 homedir 是 systemprofile，看不见别人的安装）
    try {
      const root = path.join(process.env.SystemDrive || 'C:', 'Users');
      for (const name of fs.readdirSync(root)) {
        for (const rel of [
          ['AppData', 'Local', 'Programs', 'PowerShell', '7', 'pwsh.exe'],
          ['AppData', 'Local', 'Microsoft', 'WindowsApps', 'pwsh.exe'],
        ]) {
          const exe = path.join(root, name, ...rel);
          try { if (fs.existsSync(exe)) userPwsh.push(exe) } catch {}
        }
      }
    } catch {}

    const candidates = [
      'pwsh',
      ...userPwsh,
      path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'PowerShell', '7', 'pwsh.exe'),
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    ].filter(Boolean);
    let p7 = { ok: false, out: '' };
    for (const exe of candidates) {
      p7 = await run(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 8000 });
      if (p7.ok) break;
    }
    if (p7.ok) pwshVer = shortVer(p7.out) || '7';
    if (!pwshVer) {
      const p5 = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 8000 });
      if (p5.ok) ps5Ver = shortVer(p5.out) || '5.1';
    }
  }
  const shellParts = [];
  if (pwshVer) shellParts.push(`PowerShell ${pwshVer}`);
  if (ps5Ver) shellParts.push(`Windows PowerShell ${ps5Ver}`);
  if (bashPath) shellParts.push('Bash（git-bash）');

  const shellStatus = shellParts.length === 0
    ? 'warn'
    : (pwshVer || bashPath ? 'ok' : 'warn');
  const shellDetail = shellParts.length === 0
    ? '没有找到 PowerShell 或 Bash，命令只能走老式 cmd；建议装 PowerShell 7（winget install Microsoft.PowerShell）'
    : shellParts.join(' + ')
      + (bashPath ? '' : '（没有 git-bash 不影响：命令走 PowerShell）')
      + (!pwshVer && ps5Ver ? '（建议换成 PowerShell 7：winget install Microsoft.PowerShell）' : '');
  add('bash', '命令工具', shellStatus, shellDetail);

  if (platform === 'win32') {
    const task = await run('schtasks.exe', ['/Query', '/TN', 'yuanshu-watchdog'], { timeout: 10000 });
    const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '元枢服务.lnk');
    add('autostart', '开机自启', task.ok || fsMod.existsSync(startup) ? 'ok' : 'warn', task.ok ? '计划任务 yuanshu-watchdog 已注册' : fsMod.existsSync(startup) ? '启动文件夹快捷方式' : '未注册：重启电脑后需要手动打开元枢');
  }

  add('port', '服务端口', 'ok', `127.0.0.1:${port}`);
  const summary = { ok: items.filter((i) => i.status === 'ok').length, warn: items.filter((i) => i.status === 'warn').length, fail: items.filter((i) => i.status === 'fail').length };
  return { checkedAt: new Date().toISOString(), summary, items };
}
