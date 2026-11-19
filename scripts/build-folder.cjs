const { execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const packager = require('electron-packager')
const { powerShell, powerShellArgs } = require('../electron/process.cjs')

const root = process.cwd()
const releaseDir = path.resolve(root, process.env.INSTALLR_RELEASE_DIR || 'release')
const outDir = path.join(releaseDir, 'packager')
const publicReleaseDir = path.join(releaseDir, 'public')
fs.mkdirSync(releaseDir, { recursive: true })

function removeOutputDirectory(directory) {
  if (!fs.existsSync(directory)) return
  assertOutputPath(directory)
  fs.rmSync(directory, { recursive: true, force: true })
}

function assertOutputPath(entry) {
  const resolved = fs.existsSync(entry)
    ? fs.realpathSync(entry)
    : path.join(fs.realpathSync(path.dirname(entry)), path.basename(entry))
  const relative = path.relative(fs.realpathSync(releaseDir), resolved)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Output path resolves outside the selected release directory.')
  }
}
fs.mkdirSync(publicReleaseDir, { recursive: true })

function replaceDirectory(staged, destination) {
  const backup = destination + '.previous-' + randomUUID()
  for (const entry of [staged, destination, backup]) assertOutputPath(entry)
  const hadOutput = fs.existsSync(destination)
  if (hadOutput) fs.renameSync(destination, backup)
  try {
    fs.renameSync(staged, destination)
  } catch (error) {
    if (hadOutput) fs.renameSync(backup, destination)
    throw error
  }
  try {
    removeOutputDirectory(backup)
  } catch (error) {
    console.warn('Could not remove prior build at ' + backup + '\n' + error.message)
  }
}

const ignorePatterns = [
  '^/release($|/)',
  '^/src($|/)',
  '^/scripts($|/)',
  '^/public($|/)',
  '^/tests($|/)',
  '^/node_modules($|/)',
  '^/\\.github($|/)',
  '^/\\.git($|/)',
  '^/\\.gitignore$',
  '^/package-lock\\.json$',
  '^/index\\.html$',
  '^/README\\.md$',
  '^/build-installr\\.bat$',
  '^/eslint\\.config\\.js$',
  '^/tsconfig(?:\\..*)?\\.json$',
  '^/vite\\.config\\.ts$',
]

function getKeptLocales() {
  const raw = process.env.INSTALLR_KEEP_LOCALES
  const values = (raw || 'en-US,de')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  return new Set(values.map((value) => `${value.toLowerCase()}.pak`))
}

function pruneLocales(appFolder, keptLocales) {
  const localesDir = path.join(appFolder, 'locales')
  if (!fs.existsSync(localesDir)) {
    return { removed: 0, kept: 0 }
  }

  let removed = 0
  let kept = 0

  for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.pak')) {
      continue
    }

    if (keptLocales.has(entry.name.toLowerCase())) {
      kept += 1
      continue
    }

    fs.rmSync(path.join(localesDir, entry.name), { force: true })
    removed += 1
  }

  return { removed, kept }
}

async function main() {
  const stage = fs.mkdtempSync(path.join(releaseDir, '.folder-build-'))
  const zipName = 'Installr-win32-x64.zip'
  const folderName = 'Installr-win32-x64'
  let localeResult
  try {
    const [stagedAppFolder] = await packager({
      dir: root,
      name: 'Installr',
      platform: 'win32',
      arch: 'x64',
      electronVersion: require('electron/package.json').version,
      asar: true,
      icon: path.join(root, 'public', 'installr.ico'),
      out: stage,
      ignore: ignorePatterns.map((pattern) => new RegExp(pattern)),
    })
    localeResult = pruneLocales(stagedAppFolder, getKeptLocales())
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'"
    const archiveCommand = "$ProgressPreference = 'SilentlyContinue'\nCompress-Archive -Path " + quote(path.join(stagedAppFolder, '*')) +
      ' -DestinationPath ' + quote(path.join(stage, zipName)) + ' -Force'
    execFileSync(powerShell, powerShellArgs(archiveCommand), { stdio: 'inherit', windowsHide: true })
    replaceDirectory(stage, outDir)
  } finally {
    removeOutputDirectory(stage)
  }

  const appFolder = path.join(outDir, folderName)
  const exePath = path.join(appFolder, 'Installr.exe')
  const zipPath = path.join(outDir, zipName)
  const publicAppFolder = path.join(publicReleaseDir, folderName)
  const publicExePath = path.join(publicAppFolder, 'Installr.exe')
  const publicZipPath = path.join(publicReleaseDir, zipName)

  let publicPublishError = null
  const publicStage = fs.mkdtempSync(path.join(releaseDir, '.public-build-'))
  try {
    const stagedFolder = path.join(publicStage, folderName)
    const stagedZip = path.join(publicStage, zipName)
    fs.cpSync(appFolder, stagedFolder, { recursive: true })
    fs.copyFileSync(zipPath, stagedZip)
    replaceDirectory(stagedFolder, publicAppFolder)
    assertOutputPath(publicZipPath)
    fs.renameSync(stagedZip, publicZipPath)
  } catch (error) {
    publicPublishError = error
  } finally {
    removeOutputDirectory(publicStage)
  }

  console.log(`\nBuild output (folder): ${appFolder}`)
  console.log(`Build output (exe): ${exePath}`)
  console.log(`Build output (zip): ${zipPath}`)
  if (!publicPublishError) {
    console.log(`Public output (folder): ${publicAppFolder}`)
    console.log(`Public output (exe): ${publicExePath}`)
    console.log(`Public output (zip): ${publicZipPath}`)
  } else {
    console.warn('Could not refresh all public build files.')
    console.warn(`Public publish error: ${String(publicPublishError)}`)
  }
  console.log(`Locales kept: ${localeResult.kept}, removed: ${localeResult.removed}`)
  console.log('Important: share the zip/folder and run Installr.exe from inside the extracted folder, not as a standalone copied exe.')
}

main().catch((error) => {
  console.error(String(error?.stack || error))
  process.exit(error.status ?? 1)
})
