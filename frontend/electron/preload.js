const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  locatePc: () => ipcRenderer.invoke('locate-pc'),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  setRenderMode: (mode) => ipcRenderer.invoke('set-render-mode', mode),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  // Returns whether the current backend instance was launched as root.
  // Frontend uses it to hide the "Grant admin" button after grant succeeds.
  isBackendRoot: () => ipcRenderer.invoke('is-backend-root'),
  // One-shot: re-spawn backend under sudo via osascript (lasts only
  // until the backend dies). Resolves to { ok, message }.
  requestAdminRestart: () => ipcRenderer.invoke('request-admin-restart'),
  // Permanent: install / uninstall a launchd LaunchDaemon so the
  // backend boots as root automatically on every login. installed
  // = boolean from the status query.
  launchDaemonStatus: () => ipcRenderer.invoke('launch-daemon-status'),
  launchDaemonInstall: () => ipcRenderer.invoke('launch-daemon-install'),
  launchDaemonUninstall: () => ipcRenderer.invoke('launch-daemon-uninstall'),
  platform: process.platform,
})
