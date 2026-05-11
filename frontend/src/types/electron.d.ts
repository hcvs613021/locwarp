export interface LocatePcResult {
  ok: boolean
  lat?: number
  lng?: number
  accuracy?: number
  via?: 'windows' | 'ipwho.is' | 'ipapi.co' | 'freeipapi.com'
  code?: 'DENIED' | 'TIMEOUT' | 'UNKNOWN' | 'ERROR' | 'SPAWN_FAILED' | 'NODATA' | 'ALL_FAILED'
  message?: string
}

export type RenderMode = 'hardware' | 'software'

export interface RenderModeInfo {
  mode: RenderMode
  saved: RenderMode | null
  isWin10: boolean
}

export interface AdminRestartResult {
  ok: boolean
  pid?: number
  code?: 'CANCELLED'
  message?: string
}

export interface LaunchDaemonStatus {
  installed: boolean
  error?: string
}

export interface LaunchDaemonResult {
  ok: boolean
  code?: 'CANCELLED'
  message?: string
}

declare global {
  interface Window {
    electronAPI?: {
      locatePc(): Promise<LocatePcResult>
      getRenderMode(): Promise<RenderModeInfo>
      setRenderMode(mode: RenderMode): Promise<{ ok: boolean }>
      relaunchApp(): Promise<void>
      isBackendRoot(): Promise<{ isRoot: boolean; pid: number | null }>
      requestAdminRestart(): Promise<AdminRestartResult>
      launchDaemonStatus(): Promise<LaunchDaemonStatus>
      launchDaemonInstall(): Promise<LaunchDaemonResult>
      launchDaemonUninstall(): Promise<LaunchDaemonResult>
      platform: NodeJS.Platform
    }
  }
}

export {}
