const { app, BrowserWindow, ipcMain, dialog, nativeTheme, shell, systemPreferences } = require('electron')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { runCommand, powerShell, powerShellArgs, winGet } = require('./process.cjs')
const { createInventory } = require('./inventory.cjs')
const { createInstallQueue, createJournal } = require('./install-queue.cjs')
const catalog = require('./catalog.json')

const byId = new Map(catalog.map((definition) => [definition.id, definition]))
const devUrl = 'http://localhost:5173/'
const appInstallerUrl = 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1'
const inventory = createInventory()
let mainWindow
let queue
let maintenance
let adminCheck
let wingetCheck
let closeDialog

function rendererFile() {
  return path.join(app.getAppPath(), 'dist', 'index.html')
}

function windowBackground() {
  if (nativeTheme.inForcedColorsMode) return systemPreferences.getColor('window')
  return nativeTheme.shouldUseDarkColors ? '#191d19' : '#f7f6f1'
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 600,
    autoHideMenuBar: true,
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.setTitle('Installr')
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('close', (event) => {
    if (!queue.isActive() && maintenance !== 'winget-repair') return
    event.preventDefault()
    closeDialog ||= dialog.showMessageBox(window, {
      type: 'info',
      message: 'Installr is still running a Windows command.',
      detail: 'You can stop a batch from its progress controls. Wait for the active command to finish or stop before closing Installr.',
    }).catch(() => {}).finally(() => { closeDialog = null })
  })
  window.on('closed', () => { mainWindow = null })
  const load = app.isPackaged ? window.loadFile(rendererFile()) : window.loadURL(devUrl)
  load.catch((error) => dialog.showErrorBox('Could not open Installr', error.message))
}

function register(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    const expected = app.isPackaged ? pathToFileURL(rendererFile()).href : devUrl
    if (event.sender !== mainWindow?.webContents || !event.senderFrame ||
        event.senderFrame.parent || event.senderFrame.url !== expected) {
      throw new Error('Request must come from the Installr window.')
    }
    return handler(...args)
  })
}

function notify(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
}

function getAdminState() {
  adminCheck ||= runCommand(powerShell, powerShellArgs(
    '[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
  ), { timeoutMs: 60_000 }).then((result) => {
    const status = result.stdout.trim().toLowerCase()
    if (result.success && (status === 'true' || status === 'false')) return status === 'true'
    adminCheck = null
    return null
  })
  return adminCheck
}

function checkWinget() {
  if (wingetCheck) return wingetCheck
  wingetCheck = runCommand(winGet, ['--version'], { timeoutMs: 15_000 }).then((result) => {
    if (result.success && result.stdout.trim()) return { available: true, version: result.stdout.trim() }
    return {
      available: false,
      issue: result.timedOut ? 'WinGet did not respond.' :
        result.errorCode === 'ENOENT' ? 'Windows could not find the WinGet app alias.' : 'WinGet could not start.',
    }
  }).finally(() => { wingetCheck = null })
  return wingetCheck
}

async function repairWingetAlias() {
  if (maintenance || queue.isActive()) throw new Error('Wait for the current operation to finish.')
  maintenance = 'winget-repair'
  try {
    const command = "if (-not (Get-AppxPackage -Name Microsoft.DesktopAppInstaller)) { throw 'Install App Installer from the Microsoft Store, then check again.' }\n" +
      "Add-AppxPackage -RegisterByFamilyName -MainPackage 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe'"
    const repair = await runCommand(powerShell, powerShellArgs(command), { timeoutMs: 60_000 })
    const status = await checkWinget()
    if (status.available) inventory.invalidate()
    return { ...status, issue: status.available ? undefined : repair.output || status.issue }
  } finally {
    maintenance = null
  }
}

async function restartAsAdmin() {
  if (maintenance || queue.isActive()) return { success: false, message: 'Wait for the current batch to finish.' }
  maintenance = 'restart'
  try {
    if (await getAdminState()) return { success: false, message: 'Installr is already running as administrator.' }
    const executable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'"
    const args = app.isPackaged ? '' : '"' + app.getAppPath() + '"'
    // Process.Start preserves the Win32 error code when Windows refuses elevation.
    const command = [
      '$launch = [Diagnostics.ProcessStartInfo]::new()',
      '$launch.FileName = ' + quote(executable),
      '$launch.Arguments = ' + quote(args),
      '$launch.UseShellExecute = $true',
      "$launch.Verb = 'runas'",
      'try { [void][Diagnostics.Process]::Start($launch) } catch {',
      '  $cause = $_.Exception.GetBaseException()',
      '  if ($cause -is [ComponentModel.Win32Exception] -and $cause.NativeErrorCode -eq 1223) { exit 1223 }',
      '  Write-Output $cause.Message',
      '  exit 1',
      '}',
    ].join('\n')
    app.releaseSingleInstanceLock()
    const result = await runCommand(powerShell, powerShellArgs(command), { timeoutMs: 120_000 })
    if (result.success) {
      app.quit()
      return { success: true }
    }
    if (!app.requestSingleInstanceLock()) app.quit()
    if (result.code === 1223) return { success: false, message: 'Administrator restart cancelled.' }
    return { success: false, message: result.stdout.trim() || 'The administrator restart did not start.' }
  } finally {
    maintenance = null
  }
}

function validateSelection(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 250) throw new Error('Choose between 1 and 250 apps.')
  const seen = new Set()
  return entries.map((entry) => {
    if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) throw new Error('Invalid or duplicate app selection.')
    seen.add(entry.id)
    const builtIn = byId.get(entry.id)
    if (builtIn) return builtIn
    if (entry.kind !== 'custom' || !/^custom-[\w-]{1,64}$/.test(entry.id) ||
        typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100 ||
        typeof entry.customCommand !== 'string' || !entry.customCommand.trim() || entry.customCommand.length > 6000) {
      throw new Error('A custom app has an invalid name or PowerShell command.')
    }
    return { id: entry.id, kind: 'custom', name: entry.name.trim(), customCommand: entry.customCommand }
  })
}

function validateOptions(options) {
  const locale = typeof options?.locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(options.locale)
  return {
    locale: locale ? options.locale : undefined,
    scope: ['user', 'machine'].includes(options?.scope) ? options.scope : undefined,
    architecture: ['x64', 'x86', 'arm64', 'arm'].includes(options?.architecture) ? options.architecture : undefined,
    mode: options?.mode === 'interactive' ? 'interactive' : 'silent',
    includeUnknownVersions: options?.includeUnknownVersions === true,
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (queue?.isActive() || maintenance === 'winget-repair') event.preventDefault()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.installr.desktop')
    nativeTheme.on('updated', () => mainWindow?.setBackgroundColor(windowBackground()))
    queue = createInstallQueue({
      inventory,
      journal: createJournal(path.join(app.getPath('userData'), 'install-history.json')),
      onChange: (progress) => {
        notify('installProgress', progress)
        mainWindow?.setProgressBar(progress.active ? progress.completed / progress.total : -1)
      },
    })
    register('getAdminState', getAdminState)
    register('restartAsAdmin', restartAsAdmin)
    register('checkWinget', checkWinget)
    register('openAppInstaller', () => shell.openExternal(appInstallerUrl))
    register('repairWingetAlias', repairWingetAlias)
    register('getAppsInfo', (force, resolve) => inventory.getAppsInfo(catalog, { maxAge: force === true ? 0 : undefined }, resolve === true))
    register('installApps', (entries, options) => {
      if (maintenance) throw new Error('Wait for the current Windows operation to finish.')
      return queue.install(validateSelection(entries), validateOptions(options))
    })
    register('getQueueState', () => queue.state())
    register('skipCurrentInstall', (token) => queue.skip(token))
    register('cancelRemainingInstalls', (batchId) => queue.cancelRemaining(batchId))
    createWindow()
  }).catch((error) => {
    dialog.showErrorBox('Could not start Installr', error.message)
    app.exit(1)
  })
}
