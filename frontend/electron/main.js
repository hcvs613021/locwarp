const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const os = require('os')
const fs = require('fs')

// Render-mode preference (Issue #24). Win 10 stays on software rendering
// by default — v0.2.121/125 hit a Chromium 124 GPU-sandbox crash on
// 22H2 — but users whose hardware works fine can opt in via Settings
// and restart. Win 11 defaults to hardware acceleration as usual.
const RENDER_MODE_FILE = path.join(app.getPath('userData'), 'render-mode.json')

function readRenderModePref() {
  try {
    const raw = fs.readFileSync(RENDER_MODE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.mode === 'hardware' || parsed.mode === 'software')) {
      return parsed.mode
    }
  } catch { /* missing or corrupt — fall through to default */ }
  return null
}

function writeRenderModePref(mode) {
  try {
    fs.mkdirSync(path.dirname(RENDER_MODE_FILE), { recursive: true })
    fs.writeFileSync(RENDER_MODE_FILE, JSON.stringify({ mode }, null, 2), 'utf8')
  } catch (e) {
    console.error('[render-mode] failed to save pref:', e && e.message)
  }
}

if (process.platform === 'win32') {
  const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
  const isWin10 = winBuild > 0 && winBuild < 22000
  const saved = readRenderModePref()
  // Effective mode: saved pref wins; otherwise Win 10 → software, Win 11 → hardware.
  const mode = saved || (isWin10 ? 'software' : 'hardware')
  if (mode === 'software') {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('no-sandbox')
    app.commandLine.appendSwitch('in-process-gpu')
  }
}

// Locate-PC over IPC: shells out to PowerShell + System.Device.Location
// (the Windows Location API). This taps Windows' built-in Wi-Fi
// positioning + GPS without needing a Google API key (which Electron's
// navigator.geolocation requires) or any third-party HTTP service.
// Accuracy in urban areas is typically 30-100m; rural ~500m.
const LOCATE_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
  $watcher.Start()
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
    if ($watcher.Status -eq 'Ready' -and -not $watcher.Position.Location.IsUnknown) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
  $loc = $watcher.Position.Location
  if ($loc.IsUnknown) { Write-Output ('NODATA,status=' + $watcher.Status); exit 0 }
  Write-Output ('OK,' + $loc.Latitude + ',' + $loc.Longitude + ',' + $loc.HorizontalAccuracy)
  $watcher.Stop()
} catch {
  Write-Output ('ERROR,' + $_.Exception.Message)
}
`

// Run an HTTPS GET from the Electron main process (no renderer CORS,
// no Content-Security-Policy block) and return the parsed JSON. Used
// by the IP-geolocation fallback chain inside the locate-pc handler.
const httpsGetJson = (url) => {
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get(url, { headers: { 'User-Agent': 'LocWarp-Electron' }, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch {} ; resolve(null) })
  })
}

const ipFallback = async () => {
  // ipwho.is — no key, no signup, HTTPS, returns latitude/longitude in JSON.
  const a = await httpsGetJson('https://ipwho.is/')
  if (a && typeof a.latitude === 'number' && typeof a.longitude === 'number') {
    return { ok: true, lat: a.latitude, lng: a.longitude, accuracy: 5000, via: 'ipwho.is' }
  }
  // ipapi.co — backup, also no key.
  const b = await httpsGetJson('https://ipapi.co/json/')
  if (b && b.latitude != null && b.longitude != null) {
    const lat = parseFloat(b.latitude); const lng = parseFloat(b.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'ipapi.co' }
    }
  }
  // freeipapi.com — last resort.
  const c = await httpsGetJson('https://freeipapi.com/api/json/')
  if (c && c.latitude != null && c.longitude != null) {
    const lat = parseFloat(c.latitude); const lng = parseFloat(c.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'freeipapi.com' }
    }
  }
  return null
}

const tryWindowsLocation = () => {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LOCATE_PS_SCRIPT],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => console.error('[locate-pc] stderr:', d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, code: 'SPAWN_FAILED', message: e.message }))
    child.on('exit', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('OK,')) {
        const parts = trimmed.split(',')
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        const acc = parseFloat(parts[3])
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return finish({ ok: true, lat, lng, accuracy: Number.isFinite(acc) ? acc : 100 })
        }
      }
      if (trimmed === 'DENIED') return finish({ ok: false, code: 'DENIED', message: 'Windows Location service is off or app access denied' })
      if (trimmed.startsWith('NODATA')) return finish({ ok: false, code: 'NODATA', message: trimmed.slice(0, 200) })
      if (trimmed.startsWith('ERROR,')) return finish({ ok: false, code: 'ERROR', message: trimmed.slice(6, 200) })
      finish({ ok: false, code: 'UNKNOWN', message: trimmed.slice(0, 200) || 'no PowerShell output' })
    })
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', message: 'PowerShell timed out after 18s' })
    }, 18000)
  })
}

ipcMain.handle('get-render-mode', () => {
  // Surface the current saved mode + whether the OS is the one we
  // originally bypassed (Win 10), so the Settings panel can decide
  // whether to highlight this toggle as relevant.
  let isWin10 = false
  if (process.platform === 'win32') {
    const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
    isWin10 = winBuild > 0 && winBuild < 22000
  }
  const saved = readRenderModePref()
  // If no pref exists and we're not on Win 10, the effective mode is
  // hardware (current default for Win 11). On Win 10 with no pref, we
  // already prompted at startup, so this branch shouldn't normally hit.
  const effective = saved || (isWin10 ? 'software' : 'hardware')
  return { mode: effective, saved, isWin10 }
})

ipcMain.handle('set-render-mode', (_e, mode) => {
  if (mode !== 'hardware' && mode !== 'software') return { ok: false }
  writeRenderModePref(mode)
  return { ok: true }
})

ipcMain.handle('relaunch-app', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('is-backend-root', () => ({ isRoot: backendIsRoot, pid: rootBackendPid }))

ipcMain.handle('request-admin-restart', async () => {
  return await requestAdminRestartMac()
})

const LAUNCH_DAEMON_PATH = '/Library/LaunchDaemons/com.locwarp.backend.plist'
const LAUNCH_DAEMON_LABEL = 'com.locwarp.backend'

ipcMain.handle('launch-daemon-status', () => {
  // Just check the plist. KeepAlive=true means if the plist exists,
  // launchd is supposed to be running it. If something killed it
  // permanently (kill -9, hung) the user needs to fix manually.
  try {
    return { installed: fs.existsSync(LAUNCH_DAEMON_PATH) }
  } catch (e) {
    return { installed: false, error: String(e) }
  }
})

ipcMain.handle('launch-daemon-install', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'LaunchDaemon is macOS only' }
  }
  const exe = resolveBackendExe()
  if (!exe || !fs.existsSync(exe)) {
    return { ok: false, message: 'Backend binary not found in package' }
  }

  const userInfo = os.userInfo()
  // Plist content. UserName=root means the daemon runs as root (so it
  // can create utun for iOS 17+ tunnel). HOME/USER are set to the
  // launching user's so backend reads bookmarks/routes from the user's
  // ~/.locwarp instead of root's. KeepAlive=true tells launchd to
  // restart the daemon if it dies; RunAtLoad+restart gives instant boot.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCH_DAEMON_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${exe}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${path.dirname(exe)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/var/log/locwarp-backend.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/locwarp-backend.log</string>
    <key>UserName</key>
    <string>root</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${userInfo.homedir}</string>
        <key>USER</key>
        <string>${userInfo.username}</string>
    </dict>
</dict>
</plist>
`

  // Write plist to temp first, then osascript copies it as root.
  const tmpPlist = path.join(os.tmpdir(), 'com.locwarp.backend.plist')
  try {
    fs.writeFileSync(tmpPlist, plist, 'utf8')
  } catch (e) {
    return { ok: false, message: `Failed to write temp plist: ${e.message}` }
  }

  // Kill the user-mode backend before launchctl load, otherwise both
  // fight for port 8777. Don't await shutdownBackendViaHttp here — we'd
  // rather force-kill since admin path is about to take over anyway.
  if (backendProc) { try { backendProc.kill() } catch {} ; backendProc = null }
  await shutdownBackendViaHttp().catch(() => {})
  await waitForPortClear(8777, 5000).catch(() => {})

  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
  // .app on a fresh install carries `com.apple.quarantine` from the
  // download. Gatekeeper refuses to let launchd spawn quarantined
  // binaries — daemon launches, exits silently, KeepAlive respawns,
  // throttle, and the backend never binds 8777. Strip the xattr from
  // the bundle (recursively, so it covers the binary inside) before
  // bootstrapping.
  const appBundle = '/Applications/LocWarp.app'
  // Idempotent: bootout silently if already loaded; bootstrap fresh.
  // Without bootout, a second install attempt hits "Bootstrap failed:
  // 5: Service already loaded" and we never get a clean state.
  const shellCmd =
    `xattr -dr com.apple.quarantine ${sh(appBundle)} 2>/dev/null; ` +
    `cp ${sh(tmpPlist)} ${sh(LAUNCH_DAEMON_PATH)} && ` +
    `chown root:wheel ${sh(LAUNCH_DAEMON_PATH)} && ` +
    `chmod 644 ${sh(LAUNCH_DAEMON_PATH)} && ` +
    `launchctl bootout system/${LAUNCH_DAEMON_LABEL} 2>/dev/null; ` +
    `(launchctl bootstrap system ${sh(LAUNCH_DAEMON_PATH)} 2>&1 || ` +
    ` launchctl load -w ${sh(LAUNCH_DAEMON_PATH)} 2>&1) && ` +
    `echo OK`
  const ascript = `do shell script "${shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`

  console.log('[electron][launch-daemon-install] shell:', shellCmd)

  const r = await new Promise((resolve) => {
    const child = spawn('osascript', ['-e', ascript], { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => resolve({ ok: false, message: e.message }))
    child.on('exit', (code) => {
      console.log('[electron][launch-daemon-install] exit', code, 'out:', out.trim().slice(0, 400), 'err:', err.trim().slice(0, 400))
      const trimmed = out.trim()
      if (code === 0 && trimmed.endsWith('OK')) {
        return resolve({ ok: true })
      }
      const msg = err.trim() || trimmed || `osascript exited ${code}`
      if (/-128/.test(msg) || /User canceled/i.test(msg)) {
        return resolve({ ok: false, code: 'CANCELLED', message: '使用者取消授權' })
      }
      resolve({ ok: false, message: msg })
    })
  })

  try { fs.unlinkSync(tmpPlist) } catch {}

  if (!r.ok) {
    if (app.isPackaged) startBackend()  // fall back so UI still works
    return r
  }

  // Wait for the daemon's backend to bind 8777.
  try {
    await waitForBackend(30000)
  } catch (e) {
    // Daemon was registered (plist + bootstrap succeeded) but the
    // backend didn't bind. Pull the daemon's stdout/stderr log so we
    // can surface the *actual* failure to the user — Gatekeeper kill,
    // bad path, missing dependency, etc.
    let logTail = ''
    try {
      logTail = fs.readFileSync('/var/log/locwarp-backend.log', 'utf8').slice(-1200)
    } catch {}
    return {
      ok: false,
      message: `LaunchDaemon 已安裝但 backend 未啟動 (${e.message || e})\n` +
        `\n--- /var/log/locwarp-backend.log 末尾 ---\n` +
        `${logTail || '(空白或無法讀取 — 多半是 Gatekeeper 直接 SIGKILL,binary 還沒寫 log 就被殺)'}`,
    }
  }
  backendIsRoot = true
  // backendProc stays null — we don't own this daemon anymore. The
  // before-quit handler must NOT shut it down (LaunchDaemon should
  // persist across app restarts).
  return { ok: true }
})

ipcMain.handle('launch-daemon-uninstall', async () => {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'LaunchDaemon is macOS only' }
  }
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
  const shellCmd =
    `(launchctl bootout system/${LAUNCH_DAEMON_LABEL} 2>&1 || ` +
    ` launchctl unload -w ${sh(LAUNCH_DAEMON_PATH)} 2>&1 || true); ` +
    `rm -f ${sh(LAUNCH_DAEMON_PATH)} && echo OK`
  const ascript = `do shell script "${shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`

  const r = await new Promise((resolve) => {
    const child = spawn('osascript', ['-e', ascript], { windowsHide: true })
    let out = '', err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => resolve({ ok: false, message: e.message }))
    child.on('exit', (code) => {
      const trimmed = out.trim()
      if (code === 0 && trimmed.endsWith('OK')) return resolve({ ok: true })
      const msg = err.trim() || trimmed || `osascript exited ${code}`
      if (/-128/.test(msg) || /User canceled/i.test(msg)) {
        return resolve({ ok: false, code: 'CANCELLED', message: '使用者取消' })
      }
      resolve({ ok: false, message: msg })
    })
  })

  if (r.ok) {
    backendIsRoot = false
    rootBackendPid = null
  }
  return r
})

ipcMain.handle('locate-pc', async () => {
  // Windows-only: probe System.Device.Location via PowerShell first
  // (uses Wi-Fi positioning + GPS, accurate to 30-100m). On macOS / Linux
  // we don't have an equivalent shell-callable API, so skip straight to
  // the IP-based fallback chain.
  if (process.platform === 'win32') {
    const win = await tryWindowsLocation()
    if (win.ok) return { ...win, via: 'windows' }
    if (win.code === 'DENIED') return win
    const ip = await ipFallback()
    if (ip) return ip
    return {
      ok: false,
      code: 'ALL_FAILED',
      message: `Windows Location: ${win.code}${win.message ? ' (' + win.message + ')' : ''} | IP fallback: all 3 services unreachable`,
    }
  }
  const ip = await ipFallback()
  if (ip) return ip
  return {
    ok: false,
    code: 'ALL_FAILED',
    message: 'IP fallback: all 3 services unreachable',
  }
})

// macOS needs an application menu — without one, role accelerators
// (Cmd+C/V/X/A in text inputs, Cmd+Q to quit) stop working because the
// Edit menu items that provide them no longer exist. Windows draws the
// menubar inside the window and we don't want that, so we still strip
// it there. On macOS we install a minimal app + Edit menu (everything
// uses `role` so shortcuts auto-bind to the right WebContents action).
if (process.platform === 'darwin') {
  const macTemplate = [
    {
      label: 'LocWarp',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(macTemplate))
} else {
  Menu.setApplicationMenu(null)
}

let mainWindow
let backendProc = null
// Tracks whether the currently-running backend was spawned via osascript
// + administrator privileges (macOS iOS 17+ tunnel needs root). When the
// admin-restart flow swaps in a root backend we lose the child handle —
// rely on this flag + an HTTP shutdown call for cleanup instead of kill().
let backendIsRoot = false
let rootBackendPid = null  // PID of the detached root backend, when we have it.

function resolveBackendExe() {
  // In a packaged build, extraResources places files under process.resourcesPath
  // (e.g.  .../resources/backend/locwarp-backend{,.exe}). In dev, we don't
  // spawn — the developer runs `python start.py` manually.
  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'locwarp-backend.exe' : 'locwarp-backend'
    return path.join(process.resourcesPath, 'backend', binName)
  }
  return null
}

async function isPortBound(port) {
  const net = require('net')
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port, timeout: 800 })
    socket.on('connect', () => { socket.destroy(); resolve(true) })
    socket.on('error', () => resolve(false))
    socket.on('timeout', () => { socket.destroy(); resolve(false) })
  })
}

async function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return
  if (!fs.existsSync(exe)) {
    console.error('[electron] backend binary not found at', exe)
    return
  }
  // LaunchDaemon installed → launchd already runs the backend as root,
  // KeepAlive=true so it's always up. Don't spawn a duplicate.
  if (process.platform === 'darwin' && fs.existsSync(LAUNCH_DAEMON_PATH)) {
    console.log('[electron] LaunchDaemon detected, reusing existing backend')
    backendIsRoot = true
    return
  }
  // Port already bound? Could be a leaked root backend from a previous
  // session (one-shot osascript path doesn't always survive quit cleanly),
  // a manually-spawned `sudo locwarp-backend`, or another LocWarp instance.
  // Reusing the existing backend is correct in all three cases — spawning
  // a second one just causes EADDRINUSE and exit-code-1 noise.
  if (await isPortBound(8777)) {
    console.log('[electron] port 8777 already in use, reusing existing backend')
    // We don't know if it's root or not; assume it might be (since the
    // typical reason for a leak is the one-shot root flow). The Settings
    // panel can override via isBackendRoot if it gets a real signal.
    backendIsRoot = true
    return
  }
  console.log('[electron] spawning backend:', exe)
  backendProc = spawn(exe, [], {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backendIsRoot = false
  rootBackendPid = null
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code) => {
    console.log('[electron] backend exited with code', code)
    backendProc = null
  })
}

// macOS-only: re-launch the backend with administrator privileges via
// osascript. Returns { ok, message }. The new backend is detached (we
// can't track it as a child) — rely on the /api/system/shutdown HTTP
// endpoint for cleanup instead of process.kill, since a user-mode
// Electron can't signal a root child.
async function requestAdminRestartMac() {
  if (process.platform !== 'darwin') {
    return { ok: false, message: 'Admin restart is macOS only' }
  }
  const exe = resolveBackendExe()
  if (!exe || !fs.existsSync(exe)) {
    return { ok: false, message: 'Backend binary not found in package' }
  }

  // Tear down the current user-mode backend cleanly before swapping in
  // the root one (otherwise both fight for port 8777).
  await shutdownBackendViaHttp().catch(() => {})
  if (backendProc) { try { backendProc.kill() } catch {} ; backendProc = null }

  // Wait for port 8777 to clear so the new root backend can bind.
  await waitForPortClear(8777, 5000).catch(() => {})

  const logPath = path.join(app.getPath('userData'), 'backend-root.log')
  try { fs.mkdirSync(path.dirname(logPath), { recursive: true }) } catch {}

  // Pass the *user's* HOME / USER through, otherwise the root backend
  // sees Path.home() = /var/root and writes ~/.locwarp into root's home —
  // so the user's bookmarks / pairing records aren't visible.
  const userInfo = os.userInfo()  // .username, .homedir
  const cwd = path.dirname(exe)
  const sh = (s) => `'${String(s).replace(/'/g, "'\\''")}'`

  // Why Python double-fork instead of plain `nohup ... &`:
  //   `do shell script with administrator privileges` runs under macOS
  //   Authorization Services. When osascript returns, AS tears the
  //   session down and *kills any process still attached to it*, even
  //   ones that nohup'd themselves into the background. Daemonizing via
  //   double-fork + setsid breaks the link to the auth session so the
  //   backend survives osascript exit. /usr/bin/python3 is the system
  //   Python (3.9, present on every modern macOS) — sufficient for this
  //   tiny launcher.
  // We use real newlines (not `;`) inside the python -c source because
  // `if X:; STMT` is a SyntaxError. AppleScript strings preserve
  // newlines verbatim, so wrapping the multi-line python in single
  // quotes through the shell escape is safe.
  const pidFile = path.join(app.getPath('userData'), 'backend-root.pid')
  const pyLauncher = `
import os, sys
os.chdir(${JSON.stringify(cwd)})
os.environ['HOME'] = ${JSON.stringify(userInfo.homedir)}
os.environ['USER'] = ${JSON.stringify(userInfo.username)}
# Fork 1: detach from the controlling shell.
if os.fork() != 0:
    sys.exit(0)
os.setsid()
# Fork 2: grandchild gets reparented to launchd, surviving osascript exit.
pid = os.fork()
if pid != 0:
    with open(${JSON.stringify(pidFile)}, 'w') as fp:
        fp.write(str(pid))
    sys.exit(0)
# Grandchild: redirect stdio to log file, then exec backend.
# Use os.open (raw fd int) instead of open() — Python file objects get
# garbage-collected the moment they go out of scope, which closes the
# underlying fd and makes dup2 fail with EBADF.
log_fd = os.open(${JSON.stringify(logPath)}, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
null_fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(null_fd, 0)
os.dup2(log_fd, 1)
os.dup2(log_fd, 2)
os.close(null_fd)
os.close(log_fd)
os.execvp(${JSON.stringify(exe)}, [${JSON.stringify(exe)}])
`

  const shellCmd =
    `rm -f ${sh(pidFile)}; ` +
    `/usr/bin/python3 -c ${sh(pyLauncher)} 2>&1; ` +
    `sleep 0.4; ` +
    `BPID=$(cat ${sh(pidFile)} 2>/dev/null); ` +
    `if [ -z "$BPID" ]; then echo "no PID file, see log:"; tail -c 400 ${sh(logPath)}; exit 1; fi; ` +
    `sleep 0.8; ` +
    `if ! kill -0 "$BPID" 2>/dev/null; then echo "early exit, see log:"; tail -c 400 ${sh(logPath)}; exit 1; fi; ` +
    `echo "$BPID"`
  const ascript = `do shell script "${shellCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" with administrator privileges`

  console.log('[electron][admin-restart] osascript shell command:', shellCmd)

  const result = await new Promise((resolve) => {
    const child = spawn('osascript', ['-e', ascript], { windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => { err += d.toString('utf8') })
    child.on('error', (e) => resolve({ ok: false, message: e.message }))
    child.on('exit', (code) => {
      const trimmed = out.trim()
      console.log('[electron][admin-restart] osascript exit', code, 'stdout:', trimmed.slice(0, 500), 'stderr:', err.trim().slice(0, 500))
      // The shell command echoes the PID on its first line. Subsequent
      // lines (if any) are the early-exit log tail.
      const firstLine = trimmed.split('\n')[0]
      if (code === 0 && /^\d+$/.test(firstLine)) {
        return resolve({ ok: true, pid: parseInt(firstLine, 10) })
      }
      const combined = err.trim() || trimmed
      const msg = combined || `osascript exited ${code}`
      if (/-128/.test(msg) || /User canceled/i.test(msg)) {
        return resolve({ ok: false, code: 'CANCELLED', message: '使用者取消授權' })
      }
      resolve({ ok: false, message: msg })
    })
  })

  if (!result.ok) {
    // Restart user-mode backend so the UI is at least usable again.
    if (app.isPackaged) startBackend()
    return result
  }

  rootBackendPid = result.pid
  backendIsRoot = true
  // Wait for the root backend to come up on 8777 so the UI sees a fresh
  // /api/* heartbeat the moment we resolve. 30s matches the original
  // waitForBackend used at packaged startup.
  try {
    await waitForBackend(30000)
  } catch (e) {
    return { ok: false, message: `Backend did not come up: ${e.message || e}` }
  }
  return { ok: true, pid: rootBackendPid }
}

function shutdownBackendViaHttp(timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8777, path: '/api/system/shutdown', method: 'POST',
      timeout: timeoutMs,
    }, (res) => { res.resume(); res.on('end', resolve) })
    req.on('error', reject)
    req.on('timeout', () => { try { req.destroy() } catch {} ; reject(new Error('timeout')) })
    req.end()
  })
}

function waitForPortClear(port, timeoutMs = 5000) {
  const started = Date.now()
  const net = require('net')
  return new Promise((resolve, reject) => {
    const tick = () => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => {
        s.destroy()
        if (Date.now() - started > timeoutMs) return reject(new Error('port still bound'))
        setTimeout(tick, 200)
      })
      s.on('error', () => { s.destroy(); resolve() })
    }
    tick()
  })
}

function stopBackend() {
  // Local user-mode child: signal directly.
  if (backendProc) {
    try { backendProc.kill() } catch {}
    backendProc = null
  }
  // LaunchDaemon-managed root backend? Leave it alone — it's supposed
  // to survive Electron quit (that's the whole point of installing it).
  // launchd's KeepAlive would just respawn it anyway.
  if (process.platform === 'darwin' && fs.existsSync(LAUNCH_DAEMON_PATH)) {
    return
  }
  // One-shot root backend (osascript-spawned, detached): we can't kill
  // it from user-mode Electron; ask it to self-terminate via HTTP.
  // Use a SYNCHRONOUS curl shellout — `before-quit` doesn't await async
  // promises, so an `await fetch(...)` lets Electron exit before the
  // bytes hit the wire and the root backend leaks across sessions
  // (next launch hits EADDRINUSE on 8777).
  if (backendIsRoot) {
    try {
      const { execFileSync } = require('child_process')
      execFileSync('/usr/bin/curl', [
        '-s', '-X', 'POST', '-m', '2',
        'http://127.0.0.1:8777/api/system/shutdown',
      ], { stdio: 'ignore' })
    } catch {}
    backendIsRoot = false
    rootBackendPid = null
  }
}

function waitForBackend(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get('http://127.0.0.1:8777/docs', (res) => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('backend timeout'))
        setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            'LocWarp/0.1.49 (+https://github.com/keezxc1223/locwarp)'
          details.requestHeaders['Referer'] = 'https://github.com/keezxc1223/locwarp'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LocWarp',
    // Match the app's dark theme so the initial frame isn't white while
    // the renderer attaches — previously caused a jarring white flash.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Default Chromium blocks AudioContext output until a user gesture
      // happens on the page; that breaks the route-completion alert
      // sound when a long loop finishes while the user is away from the
      // window. LocWarp is a desktop tool (not a random webpage), so
      // disable the gesture gate entirely.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  // Show the window once the first frame is painted. Combined with
  // backgroundColor above, this eliminates the blank/white boot state.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  // Open target="_blank" / external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Spawn the backend in parallel and load the UI immediately. The
    // renderer already has fetch-with-retry so it rides out the backend
    // startup race — no need to block loadFile on waitForBackend() and
    // stare at a blank window for seconds.
    startBackend()
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', stopBackend)
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
