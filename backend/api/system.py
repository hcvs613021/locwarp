"""System utility endpoints — open files / folders for the user."""

import asyncio
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

router = APIRouter(prefix="/api/system", tags=["system"])

logger = logging.getLogger(__name__)


def _is_localhost(request: Request) -> bool:
    host = (request.client.host if request.client else "") or ""
    return host in ("127.0.0.1", "::1", "localhost")


def _open_native(path: Path) -> None:
    """Open a file or folder with the OS default application.

    On Windows, when the calling process owns the foreground, a freshly
    spawned Explorer window opens *behind* it (Windows foreground lock).
    Call AllowSetForegroundWindow(ASFW_ANY) so the new Explorer process
    can claim foreground itself, then launch via Explorer directly so the
    window genuinely comes to front instead of just blinking in the
    taskbar.
    """
    if sys.platform == "win32":
        try:
            import ctypes
            ASFW_ANY = -1
            ctypes.windll.user32.AllowSetForegroundWindow(ASFW_ANY)
        except Exception:
            logger.debug("AllowSetForegroundWindow failed; explorer may open behind", exc_info=True)
        if path.is_dir():
            # explorer.exe with a folder path foregrounds the window reliably,
            # whereas os.startfile sometimes does not.
            subprocess.Popen(["explorer.exe", str(path)])
        else:
            os.startfile(str(path))  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


@router.post("/open-log")
async def open_log():
    """Open backend.log in the OS default text editor (Notepad on Windows)
    so the user can copy it for bug reports. Falls back to opening the
    log folder if the file is missing."""
    log_dir = Path.home() / ".locwarp" / "logs"
    log_file = log_dir / "backend.log"
    target = log_file if log_file.exists() else log_dir
    if not target.exists():
        log_dir.mkdir(parents=True, exist_ok=True)
        target = log_dir
    try:
        _open_native(target)
    except Exception as exc:
        logger.exception("Failed to open log path %s", target)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟 log:{exc}"})
    return {"status": "opened", "path": str(target)}


@router.post("/shutdown")
async def shutdown(request: Request):
    """Graceful self-shutdown — used by the Electron app on quit and by
    the admin-restart flow to swap a user-mode backend for a root one.

    Localhost-only so a phone (or anyone on the LAN) can't kill the
    backend over the network. Schedules SIGTERM after returning the HTTP
    response so the caller sees a clean 200.
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")

    async def _kill_soon():
        # Give uvicorn a tick to flush the response before signalling.
        await asyncio.sleep(0.2)
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            logger.exception("self-shutdown SIGTERM failed; falling back to os._exit")
            os._exit(0)

    asyncio.create_task(_kill_soon())
    return {"status": "shutting_down", "pid": os.getpid()}


class _NetworkModeBody(BaseModel):
    lan_enabled: bool


@router.get("/network-mode")
async def get_network_mode(request: Request):
    """Report the LAN-exposure setting. Localhost-only so a LAN client
    can't probe whether the host is reachable from off-box.

    * lan_enabled  — the persisted preference (applies on next start)
    * active_lan   — what THIS running process actually bound to
    * restart_required — preference differs from the running bind
    """
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    from main import app_state
    lan = bool(getattr(app_state, "_lan_enabled", False))
    active = bool(getattr(app_state, "_active_lan", False))
    return {
        "lan_enabled": lan,
        "active_lan": active,
        "restart_required": lan != active,
    }


@router.post("/network-mode")
async def set_network_mode(body: _NetworkModeBody, request: Request):
    """Persist the LAN-exposure preference. Localhost-only so nobody on
    the LAN can flip the backend to expose itself. The new bind address
    only takes effect when the backend restarts — the response signals
    whether a restart is now pending."""
    if not _is_localhost(request):
        raise HTTPException(status_code=403, detail="Localhost only")
    from main import app_state
    app_state._lan_enabled = bool(body.lan_enabled)
    try:
        app_state.save_settings()
    except Exception as exc:
        logger.exception("Failed to persist lan_enabled")
        raise HTTPException(status_code=500, detail={"code": "save_failed",
                                                     "message": f"無法儲存設定:{exc}"})
    active = bool(getattr(app_state, "_active_lan", False))
    logger.info("Network mode set: lan_enabled=%s (active=%s, restart_required=%s)",
                app_state._lan_enabled, active, app_state._lan_enabled != active)
    return {
        "lan_enabled": app_state._lan_enabled,
        "active_lan": active,
        "restart_required": app_state._lan_enabled != active,
    }


@router.post("/open-log-folder")
async def open_log_folder():
    """Open the ~/.locwarp/logs folder in the file manager."""
    log_dir = Path.home() / ".locwarp" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    try:
        _open_native(log_dir)
    except Exception as exc:
        logger.exception("Failed to open log folder %s", log_dir)
        raise HTTPException(status_code=500, detail={"code": "open_log_failed",
                                                     "message": f"無法開啟資料夾:{exc}"})
    return {"status": "opened", "path": str(log_dir)}
