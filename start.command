#!/bin/bash
# LocWarp launcher for macOS — double-click in Finder to run.
#
# Note: this script does NOT auto-sudo. iOS 17+ tunnel creation needs
# root on macOS, but if we sudo'd the whole script, npm install would
# create root-owned node_modules and pollute the user's project tree.
# If you actually need iOS 17+ simulation, close this window and run
# `sudo ./start.command` from Terminal instead.

set -e
cd "$(dirname "$0")"

if [ -z "$LOCWARP_PYTHON" ]; then
    LOCWARP_PYTHON="$(command -v python3 || true)"
fi

if [ -z "$LOCWARP_PYTHON" ] || ! "$LOCWARP_PYTHON" --version >/dev/null 2>&1; then
    echo "找不到 python3，請先安裝 Python 3.11+ (建議 3.13):"
    echo "    brew install python@3.13"
    read -n 1 -s -r -p "按任意鍵離開..."
    exit 1
fi

# Reject Python < 3.11 (backend uses PEP 604 union types).
PYV=$("$LOCWARP_PYTHON" -c "import sys; print('%d %d' % sys.version_info[:2])")
PYV_MAJOR=$(echo "$PYV" | awk '{print $1}')
PYV_MINOR=$(echo "$PYV" | awk '{print $2}')
if [ "$PYV_MAJOR" -lt 3 ] || { [ "$PYV_MAJOR" = "3" ] && [ "$PYV_MINOR" -lt 11 ]; }; then
    echo "目前 python3 是 $PYV_MAJOR.$PYV_MINOR，太舊了。"
    echo "後端使用 PEP 604 union 寫法，至少需要 Python 3.11 (建議 3.13):"
    echo "    brew install python@3.13"
    echo "    ln -sf /opt/homebrew/bin/python3.13 ~/.local/bin/python3"
    read -n 1 -s -r -p "按任意鍵離開..."
    exit 1
fi

"$LOCWARP_PYTHON" start.py
echo
read -n 1 -s -r -p "按任意鍵關閉視窗..."
