#!/data/data/com.termux/files/usr/bin/bash
# 元枢 · 安卓当服务器（Termux 版）——2026-11-06
#
# 作用：把安卓手机变成元枢的服务器（局域网内其它设备用浏览器连它）。
# 用法：
#   1. 装 Termux（F-Droid 版，不要用 Play 商店那个旧版）
#   2. 把本脚本和代码放进手机（或 git clone）
#   3. bash scripts/android-server.sh
#
# 说明：
#   · 需要 Node ≥ 22.5（node:sqlite 从 22.5 起可用；Termux 的 nodejs-lts 满足）
#   · node-pty 在安卓上大概率编译失败——它只服务"终端面板"，失败不影响主体
#   · 安卓会杀后台：脚本里调 termux-wake-lock，装 Termux 的"获取唤醒锁"
set -e

REPO_DIR="${1:-$HOME/yuanshu}"
PORT="${PORT:-8787}"

echo "== 1/5 装依赖（Node LTS + git）=="
pkg update -y
pkg install -y nodejs-lts git

echo "== 2/5 检查 Node 版本（需要 ≥ 22.5，才有 node:sqlite）=="
node -v
node -e "const [a,b]=process.versions.node.split('.').map(Number); if (a<22||(a===22&&b<5)) { console.error('Node 太旧：'+process.version+'，需要 ≥ 22.5'); process.exit(1) }"

echo "== 3/5 准备代码目录：$REPO_DIR =="
if [ ! -f "$REPO_DIR/server.mjs" ]; then
  echo "没找到 $REPO_DIR/server.mjs"
  echo "请先 clone：git clone <你的仓库> $REPO_DIR"
  exit 1
fi
cd "$REPO_DIR"

echo "== 4/5 装运行时依赖（跳过 node-pty：安卓上编译不了，只影响终端面板）=="
npm install --omit=dev --no-audit --no-fund || true
npm install ws undici linkedom sanitize-html postcss --no-audit --no-fund
node -e "try{require.resolve('node:sqlite'.replace('node:',''));}catch(e){}
try { const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:'); console.log('node:sqlite 可用 ✅') }
catch (e) { console.error('node:sqlite 不可用：' + e.message); process.exit(1) }"

echo "== 5/5 起服务（端口 $PORT）=="
termux-wake-lock 2>/dev/null || echo "（没有 termux-wake-lock，后台可能被杀）"
export PORT
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=1536}"
node server.mjs &
SERVER_PID=$!
sleep 6

echo "-- 自检 --"
curl -s -m 5 "http://127.0.0.1:$PORT/api/health" || echo "健康检查没通，看上面的日志"
IP=$(ip route get 1 2>/dev/null | awk '{print $NF; exit}' || echo "<手机局域网IP>")
cat <<EOF

元枢已经在手机上跑起来了。
  本机访问：  http://127.0.0.1:$PORT
  局域网访问：http://$IP:$PORT     ← 同一个 WiFi 下的电脑/平板用这个
  进程号：    $SERVER_PID（前台退出会一起停）

提示：
  · 手机锁屏后可能被系统杀，已申请唤醒锁；部分机型还要在"电池优化"里把 Termux 设成不限制
  · 换端口：PORT=9000 bash scripts/android-server.sh
  · 停止：kill $SERVER_PID
EOF
wait $SERVER_PID
