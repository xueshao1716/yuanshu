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

  add('pi', 'pi 引擎', piPackage && fsMod.existsSync(piPackage) ? 'ok' : 'warn', piPackage && fsMod.existsSync(piPackage) ? '已就位' : '未找到，将只用元枢自研引擎');

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

  add('bash', 'Bash（命令工具）', bashPath ? 'ok' : 'warn', bashPath || '未找到 git-bash，命令工具退回 cmd');

  if (platform === 'win32') {
    const task = await run('schtasks.exe', ['/Query', '/TN', 'yuanshu-watchdog'], { timeout: 10000 });
    const startup = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', '元枢服务.lnk');
    add('autostart', '开机自启', task.ok || fsMod.existsSync(startup) ? 'ok' : 'warn', task.ok ? '计划任务 yuanshu-watchdog 已注册' : fsMod.existsSync(startup) ? '启动文件夹快捷方式' : '未注册：重启电脑后需要手动打开元枢');
  }

  add('port', '服务端口', 'ok', `127.0.0.1:${port}`);
  const summary = { ok: items.filter((i) => i.status === 'ok').length, warn: items.filter((i) => i.status === 'warn').length, fail: items.filter((i) => i.status === 'fail').length };
  return { checkedAt: new Date().toISOString(), summary, items };
}
