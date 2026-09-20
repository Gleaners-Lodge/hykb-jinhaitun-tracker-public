#!/usr/bin/env bash
# 本地起一个静态服务器看看板。
# 必须走 http:// —— 直接双击 index.html 的话浏览器会用 file:// 协议，
# fetch 读不到 data/ 里的 JSON。

set -euo pipefail
cd "$(dirname "$0")"

PORT="${1:-8080}"

if [ ! -f data/latest.json ]; then
  echo "还没有数据，先抓一次："
  echo "  python3 scraper/fetch.py"
  exit 1
fi

echo "看板地址： http://127.0.0.1:${PORT}/"
echo "按 Ctrl+C 停止"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
