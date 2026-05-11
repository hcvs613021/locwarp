#!/bin/bash
# LocWarp, one-shot build for macOS: backend Mach-O + electron .dmg.
#
# Prereqs (install once):
#   * Python 3.13   (brew install python@3.13 — symlink so `python3` → 3.13)
#   * Node.js 18+   (brew install node)
#
# This script does NOT require admin privileges. The resulting .dmg has
# no codesign / notarization (free Apple ID can't notarize), so the
# recipient mac will see "unable to verify developer" the first time —
# right-click → 打開 once and the warning never reappears.

set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

# Resolve python (PEP 604 union types in backend require ≥3.11).
LOCWARP_PYTHON="${LOCWARP_PYTHON:-$(command -v python3 || true)}"
if [ -z "$LOCWARP_PYTHON" ]; then
    echo "找不到 python3 — 請先 brew install python@3.13" >&2
    exit 1
fi

PYV=$("$LOCWARP_PYTHON" -c "import sys; print('%d %d' % sys.version_info[:2])")
PYV_MAJOR=$(echo "$PYV" | awk '{print $1}')
PYV_MINOR=$(echo "$PYV" | awk '{print $2}')
if [ "$PYV_MAJOR" -lt 3 ] || { [ "$PYV_MAJOR" = "3" ] && [ "$PYV_MINOR" -lt 11 ]; }; then
    echo "Python ≥ 3.11 required, found $PYV_MAJOR.$PYV_MINOR" >&2
    exit 1
fi

# ─── 1/3 backend → Mach-O via PyInstaller ──────────────────────
echo
echo "============================================================"
echo " [1/3] Build backend (Python $PYV_MAJOR.$PYV_MINOR + PyInstaller)"
echo "============================================================"

# Use the project venv if it exists (created by start.py); otherwise
# build a throwaway one so we don't pollute the user's system Python.
if [ ! -d "$ROOT/.venv" ]; then
    "$LOCWARP_PYTHON" -m venv "$ROOT/.venv"
fi
VENV_PY="$ROOT/.venv/bin/python"

# Avoid pip 26.1.1 (vendored rich.markup is missing — venv breaks).
"$VENV_PY" -m pip install -q -r "$ROOT/backend/requirements.txt" pyinstaller

rm -rf "$ROOT/dist-py" "$ROOT/build-py/backend"
( cd "$ROOT/backend" && \
    "$VENV_PY" -m PyInstaller locwarp-backend.spec --noconfirm \
        --distpath "$ROOT/dist-py" --workpath "$ROOT/build-py/backend" )

if [ ! -x "$ROOT/dist-py/locwarp-backend/locwarp-backend" ]; then
    echo "Backend build failed — binary not found" >&2
    exit 1
fi

# ── Patch: pyexpat + libexpat for older macOS ──────────────
# Homebrew's Python 3.13 is built with MACOSX_DEPLOYMENT_TARGET=26 and
# its bundled pyexpat.cpython-313-darwin.so links to /usr/lib/libexpat
# using a symbol (XML_SetAllocTrackerActivationThreshold) that only
# exists in libexpat shipped with macOS 26+. On macOS 15 / Sonoma /
# older the system libexpat is too old → dlopen fails → backend dies
# at "import plistlib" before uvicorn even starts.
#
# Fix: bundle our libexpat (from brew expat 2.8.0+ which has the
# symbol), patch its minos via vtool down to 11.0 so dyld accepts it
# on older systems, redirect pyexpat.so to load it from the bundle.
echo
echo "============================================================"
echo " [1.5/3] Patch pyexpat → bundle portable libexpat"
echo "============================================================"
DYNLOAD="$ROOT/dist-py/locwarp-backend/_internal/python3.13/lib-dynload"
PYEXPAT="$DYNLOAD/pyexpat.cpython-313-darwin.so"
if [ -f "$PYEXPAT" ]; then
    if [ ! -f /opt/homebrew/opt/expat/lib/libexpat.1.dylib ]; then
        echo "brew expat not installed; running: brew install expat"
        brew install expat || exit 1
    fi
    BREW_EXPAT=$(readlink -f /opt/homebrew/opt/expat/lib/libexpat.1.dylib 2>/dev/null \
        || /opt/homebrew/opt/expat/lib/libexpat.1.dylib)
    [ -z "$BREW_EXPAT" ] && BREW_EXPAT=/opt/homebrew/opt/expat/lib/libexpat.1.12.0.dylib
    vtool -set-build-version macos 11.0 26.4 -replace \
        -output "$DYNLOAD/libexpat.1.dylib" "$BREW_EXPAT" || exit 1
    codesign --force --sign - "$DYNLOAD/libexpat.1.dylib" || exit 1
    install_name_tool -change /usr/lib/libexpat.1.dylib \
        @loader_path/libexpat.1.dylib "$PYEXPAT" || exit 1
    codesign --force --sign - "$PYEXPAT" || exit 1
    echo "  patched: $PYEXPAT → @loader_path/libexpat.1.dylib (minos 11.0)"
else
    echo "  WARNING: $PYEXPAT not found, skipping libexpat patch" >&2
fi

# ─── 2/3 frontend → vite build ─────────────────────────────────
echo
echo "============================================================"
echo " [2/3] Build frontend (Vite)"
echo "============================================================"
( cd "$ROOT/frontend" && \
    [ -d node_modules ] || npm install && \
    npm run build )

# ─── 3/3 electron-builder → .dmg (signed + notarized) ──────────
echo
echo "============================================================"
echo " [3/3] Package Electron .dmg + sign + notarize"
echo "============================================================"

# Load Developer ID + App Store Connect API credentials from a
# gitignored env file (created the first time you sign — see
# .notarize.env.example for the template). Without these,
# electron-builder falls back to skipping signing & notarization.
if [ -f "$ROOT/.notarize.env" ]; then
    # shellcheck disable=SC1091
    . "$ROOT/.notarize.env"
    echo "  loaded notarize creds (key id: ${APPLE_API_KEY_ID:-???})"
else
    echo "  WARNING: .notarize.env missing — building unsigned dmg" >&2
fi

# Build output dir. If the project lives under an iCloud-synced
# location (~/Desktop, ~/Documents) the fileprovider keeps re-tagging
# the freshly-built .app with com.apple.FinderInfo xattrs, which codesign
# then rejects with "resource fork, Finder information, or similar
# detritus not allowed". Override LOCWARP_BUILD_DIR in .notarize.env
# (or your shell env) to a path *outside* iCloud, e.g. $HOME/locwarp-build.
LOCWARP_BUILD_DIR="${LOCWARP_BUILD_DIR:-$HOME/locwarp-build}"
echo "  output: $LOCWARP_BUILD_DIR"

( cd "$ROOT/frontend" && \
    npx electron-builder --mac dmg --arm64 \
        -c.directories.output="$LOCWARP_BUILD_DIR" )

echo
echo "============================================================"
echo " DONE — installer is in $LOCWARP_BUILD_DIR/"
echo "============================================================"
ls -lh "$LOCWARP_BUILD_DIR"/*.dmg 2>/dev/null || true
