# ============================================================
#  元枢安装界面 · 模拟演示（不装任何东西）
#  复用 install.ps1 / install-all.ps1 同一套 UI 函数，
#  模拟完整安装流程让你预览美化效果（含颜色）。
#  跑法：powershell -ExecutionPolicy Bypass -File install-demo.ps1
# ============================================================
$UI = @{ C='DarkCyan'; T='Cyan'; H='White'; Ok='Green'; Err='Red'; Warn='Yellow'; Dim='DarkGray'; Info='Cyan' }
function H  { param($s,$c) if($s -eq ''){Write-Host ''}else{Write-Host $s -ForegroundColor $c} }
function Line { H ('  ' + ('─' * 54)) $UI.C }
$UI_W = 46
function TextWidth { param($s) $w=0; foreach($ch in [char[]]$s){ if([int]$ch -gt 0x2E80){$w+=2}else{$w+=1} }; return $w }
function PadTo { param($s,$len) return ($s + (' ' * [Math]::Max(0,($len - (TextWidth $s))))) }
function Banner {
  H '' ''
  $bar = '═' * ($UI_W + 4)
  H ('  ╔' + $bar + '╗') $UI.C
  H ('  ║  ' + (PadTo '元枢 · 小语 AI 工作台' $UI_W) + '  ║') $UI.T
  H ('  ║  ' + (PadTo '一键安装 · 全自动（pi + dsh 双引擎一次就位）' $UI_W) + '  ║') $UI.H
  H ('  ╚' + $bar + '╝') $UI.C
  H '' ''
}
function Step { param($n,$total,$name)
  H '' ''; Line
  H ("  ── 步骤 {0}/{1} · {2} " + ('─' * [Math]::Max(2,(38 - $name.Length)))) $UI.T
  Line
}
function Ok   { param($s) H ('  ✔  ' + $s) $UI.Ok }
function Err  { param($s) H ('  ✖  ' + $s) $UI.Err }
function Warn { param($s) H ('  ⚠  ' + $s) $UI.Warn }
function Info { param($s) H ('     ' + $s) $UI.Info }
function Dim  { param($s) H ('     ' + $s) $UI.Dim }
function KeyVal { param($k,$v) H ('  ' + (PadTo $k 14) + ': ' + $v) $UI.Info }

# ── 模拟安装流程 ──
Banner

Step 1 5 '运行时 · git'
Ok 'git 已就绪  (git version 2.45.1.windows.1)'
Warn '这里展示一条警示：某软件仍未装，但会走兜底方案继续（黄色）'

Step 2 5 '运行时 · Node.js'
Ok 'Node 已就绪  (v22.22.3)'

Step 3 5 '获取元枢源码'
Info '用 git clone（Gitee 国内源）...'
Ok '源码就绪'

Step 4 5 '兼容适配器 · 初始化'
Ok '兼容适配器安装完成'
H '     ─ dsh 引擎（DeepSeek Harness）' $UI.Info
Ok 'dsh 安装完成  (0.9.2)'

Step 5 5 '确认服务状态'
Ok '服务运行中  http://127.0.0.1:8787'
Err '这里展示一条失败：某步骤报错（红色，会附指引）'

H '' ''
H ('  ╔' + ('═' * ($UI_W + 4)) + '╗') $UI.C
H ('  ║  ' + (PadTo '安装完成 ✅  元枢已就位' $UI_W) + '  ║') $UI.Ok
H ('  ╚' + ('═' * ($UI_W + 4)) + '╝') $UI.C
H '' ''
KeyVal '访问地址' 'http://127.0.0.1:8787'
KeyVal '源码目录' 'C:\Users\you\pi-web'
KeyVal '访问令牌' '首次启动后读取本机 .token 文件'
KeyVal '引擎就位' 'pi（工作台主引擎）+ dsh（执行臂）'
H '' ''
H '  ── 配置 API 密钥（必做，否则模型不可用）───────────────' $UI.Warn
Info '1) 获取密钥: https://platform.deepseek.com → API Keys → 创建，复制 sk- 开头密钥'
Dim '2) 新建文件 ~/.pi/agent/auth.json，内容：'
H '       { "deepseek": { "type": "api_key", "key": "sk-你的密钥" } }' $UI.Dim
Info '3) 重启服务: taskkill /F /IM node.exe ，然后 cd pi-web && node server.mjs'
Info '4) 刷新 http://127.0.0.1:8787 即可对话（默认模型 deepseek-v4-flash 官方直连兜底）'
Dim '停止服务: taskkill /F /IM node.exe'
H '' ''
