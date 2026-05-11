"""
LocWarp 一鍵啟動器
雙擊此檔案即可啟動 LocWarp
"""

import subprocess
import sys
import os
import time
import shutil
import webbrowser
import urllib.request
import socket

# 路徑設定
ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")
VENV_DIR = os.path.join(ROOT, ".venv")

BACKEND_PORT = 8777
FRONTEND_PORT = 5173

procs = []


def venv_python():
    """Path to the project venv's python interpreter, or None if no venv.

    Used on POSIX (macOS / Linux) where Homebrew + system Pythons are
    PEP 668 'externally-managed' and refuse global pip installs. On
    Windows we keep using the global interpreter, matching the original
    behaviour.
    """
    if os.name == "nt":
        candidate = os.path.join(VENV_DIR, "Scripts", "python.exe")
    else:
        candidate = os.path.join(VENV_DIR, "bin", "python")
    return candidate if os.path.isfile(candidate) else None


def ensure_venv():
    """Create .venv on POSIX if it doesn't exist. No-op on Windows."""
    if os.name == "nt":
        return None
    py = venv_python()
    if py:
        return py
    print(f"      首次啟動,建立虛擬環境 {VENV_DIR}...", flush=True)
    subprocess.run([sys.executable, "-m", "venv", VENV_DIR], check=True)
    py = venv_python()
    if not py:
        raise RuntimeError(f"venv 建立失敗,找不到 {VENV_DIR}")
    # Bump pip inside the venv so Resolver can fetch pymobiledevice3 wheels
    # cleanly. Quiet mode — chatter just noise on a fresh launch.
    subprocess.run([py, "-m", "pip", "install", "--upgrade", "pip", "-q"])
    return py


def backend_python():
    """Interpreter used to install backend deps and run main.py.

    Prefers the project venv (POSIX); falls back to whatever Python is
    running this launcher. Either way it returns the SAME interpreter
    for both pip-install and main-spawn so they always agree on
    site-packages.
    """
    return venv_python() or sys.executable


def print_banner():
    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   LocWarp — iOS 虛擬定位模擬器 v0.1     ║")
    print("  ╚══════════════════════════════════════════╝")
    print()


def check_tool(name, hint):
    if shutil.which(name):
        print(f"  [✓] 已找到 {name}")
        return True
    else:
        print(f"  [✗] 找不到 {name}，請先安裝：{hint}")
        return False


def is_port_open(port):
    """檢查 port 是否有服務在監聽"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def kill_port(port):
    """清理佔用指定 port 的進程"""
    if os.name == "nt":
        result = subprocess.run(
            f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
            capture_output=True, text=True, shell=True,
        )
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts:
                pid = parts[-1]
                subprocess.run(f"taskkill /pid {pid} /f",
                               shell=True, capture_output=True)
    else:
        # macOS / Linux: ask lsof who's listening on this TCP port and SIGKILL them.
        try:
            result = subprocess.run(
                ["lsof", "-nP", "-iTCP:%d" % port, "-sTCP:LISTEN", "-t"],
                capture_output=True, text=True,
            )
        except FileNotFoundError:
            return
        for pid in result.stdout.strip().splitlines():
            pid = pid.strip()
            if not pid:
                continue
            try:
                subprocess.run(["kill", "-9", pid], capture_output=True)
            except Exception:
                pass


def wait_for_port(port, label, timeout=60):
    print(f"      等待{label}啟動中", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        if is_port_open(port):
            print(" OK ✓")
            return True
        print(".", end="", flush=True)
        time.sleep(2)
    print(" 超時！")
    return False


def install_backend():
    print("  [1/4] 檢查後端依賴...", end=" ", flush=True)
    req = os.path.join(BACKEND, "requirements.txt")
    py = ensure_venv() if os.name != "nt" else sys.executable

    dry = subprocess.run(
        [py, "-m", "pip", "install", "-r", req, "--dry-run", "-q"],
        capture_output=True, text=True,
    )

    if "would install" not in dry.stdout.lower():
        print("已就緒 ✓")
    else:
        print("安裝中...")
        subprocess.run(
            [py, "-m", "pip", "install", "-r", req, "-q"],
            cwd=BACKEND,
        )
        print("        完成 ✓")


def install_frontend():
    print("  [2/4] 檢查前端依賴...", end=" ", flush=True)
    nm = os.path.join(FRONTEND, "node_modules")
    if os.path.isdir(nm):
        print("已就緒 ✓")
    else:
        print("安裝中...")
        # shell=True is needed on Windows so cmd.exe finds npm.cmd, but on
        # POSIX shells with shell=True the list args are silently dropped.
        subprocess.run(["npm", "install"], cwd=FRONTEND, shell=(os.name == "nt"))
        print("        完成 ✓")


def start_backend():
    print(f"  [3/4] 啟動後端服務 (port {BACKEND_PORT})...")

    # 清理殘留
    if is_port_open(BACKEND_PORT):
        print(f"      Port {BACKEND_PORT} 被佔用，清理中...")
        kill_port(BACKEND_PORT)
        time.sleep(1)

    backend_popen_kwargs = {"cwd": BACKEND}
    if os.name == "nt":
        backend_popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    p = subprocess.Popen(
        [backend_python(), "main.py"],
        **backend_popen_kwargs,
    )
    procs.append(p)
    return wait_for_port(BACKEND_PORT, "後端")


def start_frontend():
    print(f"  [4/4] 啟動前端服務 (port {FRONTEND_PORT})...")

    # 清理殘留
    if is_port_open(FRONTEND_PORT):
        print(f"      Port {FRONTEND_PORT} 被佔用，清理中...")
        kill_port(FRONTEND_PORT)
        time.sleep(1)

    # 用 --port 強制指定 port，避免 Vite 跳到其他 port
    popen_kwargs = {
        "cwd": FRONTEND,
        "shell": (os.name == "nt"),
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    p = subprocess.Popen(
        ["npx", "vite", "--host", "--port", str(FRONTEND_PORT), "--strictPort"],
        **popen_kwargs,
    )
    procs.append(p)
    return wait_for_port(FRONTEND_PORT, "前端")


def cleanup():
    print("\n  正在關閉所有服務...")
    for p in procs:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    # 強制清理殘留 port
    kill_port(BACKEND_PORT)
    kill_port(FRONTEND_PORT)
    print("  已停止。再見！")


def check_admin():
    """Check if running with administrator / root privileges.

    Windows: shell32.IsUserAnAdmin via ctypes. POSIX (macOS/Linux):
    effective uid 0. iOS 17+ tunnel creation needs the elevated path on
    every OS — Windows for tunneling driver access, macOS for utun
    creation by pymobiledevice3.
    """
    if os.name == "nt":
        import ctypes
        try:
            return bool(ctypes.windll.shell32.IsUserAnAdmin())
        except Exception:
            return False
    return os.geteuid() == 0


def main():
    if os.name == "nt":
        os.system("title LocWarp")
    print_banner()

    # 檢查管理員 / root 權限 (iOS 17+ 需要建立 tunnel 才能模擬定位)
    if not check_admin():
        print("  [!] 未以系統管理員 / root 身份執行")
        print("      iOS 17+ 裝置需要建立 tunnel,才能模擬定位")
        if os.name == "nt":
            print("      請右鍵 LocWarp.bat → 以系統管理員身份執行")
        else:
            print("      請改用:  sudo python3 start.py")
            print("      (或雙擊 start.command,腳本會自動 sudo)")
        print()

    # 檢查環境 — Homebrew / 系統 macOS 沒裝 `python` 別名,只有 `python3`
    py_cmd = "python" if os.name == "nt" else "python3"
    py_hint = ("https://www.python.org/downloads/" if os.name == "nt"
               else "brew install python@3.13")
    ok = True
    ok = check_tool(py_cmd, py_hint) and ok
    ok = check_tool("node", "https://nodejs.org/") and ok
    ok = check_tool("npm", "隨 Node.js 一起安裝") and ok
    print()

    if not ok:
        input("  缺少必要工具，請安裝後重試。按 Enter 離開...")
        return

    # 安裝依賴
    install_backend()
    print()
    install_frontend()
    print()

    # 啟動服務
    if not start_backend():
        print("  [錯誤] 後端啟動失敗，請查看上方錯誤訊息")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    if not start_frontend():
        print("  [錯誤] 前端啟動失敗")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    # 等待 Vite 完成首次編譯後再開瀏覽器
    time.sleep(2)
    url = f"http://localhost:{FRONTEND_PORT}"
    webbrowser.open(url)

    print("  ╔══════════════════════════════════════════╗")
    print("  ║          LocWarp 已就緒！                ║")
    print("  ╠══════════════════════════════════════════╣")
    print(f"  ║  前端畫面:  http://localhost:{FRONTEND_PORT}        ║")
    print(f"  ║  後端 API:  http://localhost:{BACKEND_PORT}        ║")
    print(f"  ║  API 文件:  http://localhost:{BACKEND_PORT}/docs   ║")
    print("  ╠══════════════════════════════════════════╣")
    print("  ║  按 Enter 停止所有服務                   ║")
    print("  ╚══════════════════════════════════════════╝")
    print()

    try:
        input()
    except (KeyboardInterrupt, EOFError):
        pass

    cleanup()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        cleanup()
