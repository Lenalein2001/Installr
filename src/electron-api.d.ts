export type BuiltInApp = {
  id: string
  name: string
  kind: 'winget'
  category: string
  wingetId: string
  source?: string
  priority?: number
}

export type CustomApp = {
  id: string
  name: string
  kind: 'custom'
  category: 'Custom'
  customCommand: string
}

export type InstallApp = BuiltInApp | CustomApp

export type AppStatus = 'not-installed' | 'up-to-date' | 'update-available' | 'update-blocked' | 'unknown'

export type AppInfo = {
  id: string
  isInstalled: boolean | null
  currentVersion: string | null
  remoteVersion: string | null
  status: AppStatus
  canUpgradeUnknown?: boolean
}

export type InstallOptions = {
  locale: string
  scope: '' | 'user' | 'machine'
  architecture: '' | 'x64' | 'x86' | 'arm64'
  mode: 'silent' | 'interactive'
  includeUnknownVersions: boolean
}

export type Outcome = 'installed' | 'updated' | 'custom-complete' | 'up-to-date' | 'reboot-required' |
  'skipped' | 'blocked' | 'failed' | 'interrupted' | 'not-run'

export type InstallJob = {
  id: string
  name: string
  token: string
  phase: 'pending' | 'checking' | 'running' | 'done'
  action?: 'install' | 'upgrade' | 'custom'
  result?: { outcome: Outcome; code?: number; output: string; retryAfterReboot?: boolean }
}

export type InstallBatch = {
  id: string
  startedAt: number
  finishedAt?: number
  issue?: string
  jobs: InstallJob[]
}

export type InstallProgress = {
  batchId: string
  active: boolean
  total: number
  completed: number
  cancelling: boolean
  changed?: boolean
  issue?: string
  job?: InstallJob
}

export type InventoryState = { apps: AppInfo[]; checkedAt: number; issue: string | null; checkingUnmatched: boolean }
export type WinGetState = { available: boolean; version?: string; issue?: string }

type ElectronAPI = {
  getAdminState: () => Promise<boolean | null>
  restartAsAdmin: () => Promise<{ success: boolean; message?: string }>
  checkWinget: () => Promise<WinGetState>
  openAppInstaller: () => Promise<void>
  repairWingetAlias: () => Promise<WinGetState>
  getAppsInfo: (force?: boolean, resolve?: boolean) => Promise<InventoryState>
  installApps: (apps: InstallApp[], options: InstallOptions) => Promise<InstallBatch>
  getQueueState: () => Promise<{ activeBatch: InstallBatch | null; history: InstallBatch[]; cancelling: boolean; issue?: string }>
  skipCurrentInstall: (token: string) => Promise<{ accepted: boolean; message?: string }>
  cancelRemainingInstalls: (batchId: string) => Promise<boolean>
  onInstallProgress: (callback: (data: InstallProgress) => void) => () => void
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
