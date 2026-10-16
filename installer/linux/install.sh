#!/bin/sh
# 元枢 Linux 安装脚本：由 .run 自解压后调用，也可直接在解开的目录里运行。
# 不需要 root：程序装到 ~/.local/share/yuanshu，服务用 systemd 用户服务（没有 systemd 时退回 XDG 自启动）。
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
PREFIX="${YUANSHU_PREFIX:-$HOME/.local/share/yuanshu}"
SERVICE=1
UNINSTALL=0
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --prefix=*) PREFIX="${1#--prefix=}"; shift;;
    --no-service) SERVICE=0; shift;;
    --uninstall) UNINSTALL=1; shift;;
    --purge) PURGE=1; shift;;
    *) echo "未知参数：$1"; exit 2;;
  esac
done
case "$PREFIX" in /*) ;; *) PREFIX="$(pwd)/$PREFIX";; esac

if [ "$UNINSTALL" = 1 ]; then
  exec sh "$HERE/uninstall.sh" --prefix "$PREFIX" $([ "$PURGE" = 1 ] && echo --purge)
fi

VERSION=$(cat "$HERE/VERSION")
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
AUTOSTART_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
BIN_DIR="$HOME/.local/bin"
HAS_SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then HAS_SYSTEMD=1; fi

echo "安装元枢 $VERSION → $PREFIX"
if [ -d "$PREFIX/app" ]; then
  echo "检测到已安装的版本，按升级处理（令牌、设置、已装的可选组件与工作区都保留）"
  if [ "$HAS_SYSTEMD" = 1 ]; then systemctl --user stop yuanshu.service 2>/dev/null || true; fi
  # 旧服务可能不是 systemd 起的：按端口上的健康实例再等一下它退出
  pkill -f "$PREFIX/launcher/service.cjs" 2>/dev/null || true
  pkill -f "$PREFIX/app/server.mjs" 2>/dev/null || true
  sleep 1
  rm -rf "$PREFIX/runtime/node" "$PREFIX/runtime/python" "$PREFIX/app/node_modules" "$PREFIX/launcher"
fi
mkdir -p "$PREFIX"
cp -a "$HERE/app" "$HERE/runtime" "$HERE/launcher" "$HERE/template" "$HERE/yuanshu.png" "$HERE/VERSION" "$HERE/uninstall.sh" "$PREFIX/"
chmod +x "$PREFIX/uninstall.sh"

# 命令行入口：yuanshu 打开界面（服务没跑会先拉起）；yuanshu service 前台跑服务
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/yuanshu" <<EOS
#!/bin/sh
P="$PREFIX"
case "\$1" in
  service) exec "\$P/runtime/node/bin/node" "\$P/launcher/service.cjs";;
  uninstall) shift; exec sh "\$P/uninstall.sh" --prefix "\$P" "\$@";;
  *) exec "\$P/runtime/node/bin/node" "\$P/launcher/open.cjs" "\$@";;
esac
EOS
chmod +x "$BIN_DIR/yuanshu"

mkdir -p "$APP_DIR"
cat > "$APP_DIR/yuanshu.desktop" <<EOS
[Desktop Entry]
Type=Application
Name=元枢
Comment=元枢 · 你的 AI 伙伴
Exec=$BIN_DIR/yuanshu
Icon=$PREFIX/yuanshu.png
Terminal=false
Categories=Utility;
EOS

if [ "$SERVICE" = 1 ]; then
  if [ "$HAS_SYSTEMD" = 1 ]; then
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/yuanshu.service" <<EOS
[Unit]
Description=元枢服务

[Service]
ExecStart=$PREFIX/runtime/node/bin/node $PREFIX/launcher/service.cjs
WorkingDirectory=$PREFIX/app
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOS
    systemctl --user daemon-reload
    systemctl --user enable --now yuanshu.service
    echo "已注册 systemd 用户服务 yuanshu.service（登录后自启）。想在没登录时也运行：loginctl enable-linger \$USER"
  else
    mkdir -p "$AUTOSTART_DIR"
    cat > "$AUTOSTART_DIR/yuanshu-service.desktop" <<EOS
[Desktop Entry]
Type=Application
Name=元枢服务
Exec=$PREFIX/runtime/node/bin/node $PREFIX/launcher/service.cjs
Terminal=false
X-GNOME-Autostart-enabled=true
EOS
    nohup "$PREFIX/runtime/node/bin/node" "$PREFIX/launcher/service.cjs" >/dev/null 2>&1 &
    echo "没有检测到 systemd 用户会话：已改用 XDG 自启动，并已在后台启动服务。"
  fi
fi

if [ "$SERVICE" = 1 ]; then
  printf "等待服务就绪"
  i=0
  while [ $i -lt 60 ]; do
    if "$PREFIX/runtime/node/bin/node" -e 'fetch("http://127.0.0.1:8787/api/health").then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then READY=1; break; fi
    printf "."; i=$((i+1)); sleep 1
  done
  echo
  if [ "${READY:-0}" = 1 ]; then echo "服务已就绪。"; else echo "服务 60 秒内没响应：用 'journalctl --user -u yuanshu -e' 或 '$PREFIX/app/watchdog.log' 看原因。"; fi
fi

cat <<EOS

安装完成。
  打开元枢：运行 yuanshu（或在应用菜单里找「元枢」）；确保 $BIN_DIR 在 PATH 里
  浏览器地址：http://127.0.0.1:8787/（访问令牌在 $PREFIX/app/.token）
  工作区：${YUANSHU_CWD:-$([ -d "$HOME/pi-workspace" ] && echo "$HOME/pi-workspace" || echo "$HOME/yuanshu-space")}
  卸载：yuanshu uninstall [--purge]
EOS
