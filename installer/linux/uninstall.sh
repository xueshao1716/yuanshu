#!/bin/sh
# 元枢 Linux 卸载：默认保留工作区（记忆、会话、灵魂都在里面）；--purge 才一并删除。
set -e
PREFIX="${YUANSHU_PREFIX:-$HOME/.local/share/yuanshu}"
PURGE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift 2;;
    --purge) PURGE=1; shift;;
    *) shift;;
  esac
done
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now yuanshu.service 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/yuanshu.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi
pkill -f "$PREFIX/launcher/service.cjs" 2>/dev/null || true
pkill -f "$PREFIX/app/server.mjs" 2>/dev/null || true
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/autostart/yuanshu-service.desktop" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/yuanshu.desktop" "$HOME/.local/bin/yuanshu"
sleep 1
rm -rf "$PREFIX"
if [ "$PURGE" = 1 ]; then rm -rf "${YUANSHU_CWD:-$HOME/pi-workspace}"; echo "已卸载，工作区一并删除。"
else echo "已卸载。工作区 ${YUANSHU_CWD:-$HOME/pi-workspace} 保留（要删除请加 --purge）。"; fi
