"""
LocWarp 一鍵停止
"""

import os
import subprocess


def _kill_port(port: int) -> None:
    if os.name == "nt":
        result = subprocess.run(
            f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
            capture_output=True, text=True, shell=True,
        )
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts:
                pid = parts[-1]
                subprocess.run(f"taskkill /pid {pid} /f", shell=True,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    # macOS / Linux
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
        subprocess.run(["kill", "-9", pid],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    print("  正在停止 LocWarp...")
    for port in (8777, 5173):
        _kill_port(port)
    print("  LocWarp 已停止。")


if __name__ == "__main__":
    main()
    input("  按 Enter 離開...")
