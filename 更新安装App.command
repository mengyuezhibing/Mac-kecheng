#!/bin/bash
# 把最新打包好的 App 覆盖安装到「应用程序」并启动（双击运行，无需输入命令）
set -u
cd "$(dirname "$0")"
clear
echo "== Mac简易课程表 · 更新安装 =="

if [ ! -d "dist/mac-arm64/Mac简易课程表.app" ]; then
  echo "未找到打包产物，请先确保已执行过一次打包。"
  read -r -p "按回车关闭…"
  exit 1
fi

pkill -f "Mac简易课程表" 2>/dev/null
sleep 1
rm -rf "/Applications/Mac简易课程表.app"
cp -R "dist/mac-arm64/Mac简易课程表.app" /Applications/ && \
  xattr -cr "/Applications/Mac简易课程表.app" && \
  echo "已安装到「应用程序」。" && \
  open "/Applications/Mac简易课程表.app" && \
  echo "已启动新版 App。"
echo
read -r -p "按回车关闭本窗口…"
