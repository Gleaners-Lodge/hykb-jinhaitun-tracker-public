#!/usr/bin/env bash
# 在 macOS 上装两个定时任务：
#   每小时 05 分  抓一次热度快照        (fetch.py)
#   每天 04:20    补一次作品档案/评分   (enrich.py --refresh)
#
# 用 launchd 而不是 crontab —— 合盖睡眠错过的任务，醒来后 launchd 会补跑一次。
#
#   ./scheduler/install.sh            装上并立刻启动
#   ./scheduler/install.sh uninstall  卸掉

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
PY="$(command -v python3)"

FETCH_LABEL="com.hykb.jinhaitun.fetch"
ENRICH_LABEL="com.hykb.jinhaitun.enrich"

uninstall() {
  for label in "$FETCH_LABEL" "$ENRICH_LABEL"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$AGENTS/$label.plist"
    echo "已移除 $label"
  done
}

if [ "${1:-}" = "uninstall" ]; then
  uninstall
  exit 0
fi

mkdir -p "$AGENTS" "$ROOT/logs"

write_plist() {
  local label="$1" script="$2"; shift 2
  local args=""
  for a in "$@"; do args="$args
    <string>$a</string>"; done

  cat > "$AGENTS/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$ROOT/scraper/$script</string>$args
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$ROOT/logs/$label.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/$label.err.log</string>
  <key>RunAtLoad</key><false/>
  <key>StartCalendarInterval</key>
  <dict>
    $PLIST_SCHEDULE
  </dict>
</dict>
</plist>
PLIST
}

PLIST_SCHEDULE="<key>Minute</key><integer>5</integer>"
write_plist "$FETCH_LABEL" "fetch.py"

PLIST_SCHEDULE="<key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>20</integer>"
write_plist "$ENRICH_LABEL" "enrich.py" "--refresh"

for label in "$FETCH_LABEL" "$ENRICH_LABEL"; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$label.plist"
  echo "已装上 $label"
done

echo
echo "热度快照：每小时 05 分"
echo "档案补全：每天 04:20"
echo "日志：     $ROOT/logs/"
echo
echo "想立刻跑一次： launchctl kickstart gui/$(id -u)/$FETCH_LABEL"
echo "想卸掉：       ./scheduler/install.sh uninstall"
