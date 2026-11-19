const { spawn } = require('node:child_process')
const { mkdir, mkdtemp, open, realpath, rename, rm } = require('node:fs/promises')
const path = require('node:path')
const { version } = require('../package.json')

const installerName = `Installr-Setup-${version}.exe`
const builder = require.resolve('electron-builder/cli.js')

function isNsisOutputError(output) {
  return /makensis(?:\.exe)?/i.test(output) && /can(?:not|'t) open output file|output file is locked for writing/i.test(output)
}

function compile(directory) {
  return new Promise((resolve, reject) => {
    const args = [builder, '--win', 'nsis', '--publish', 'never', `--config.directories.output=${directory}`]
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    for (const [stream, terminal] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      stream.setEncoding('utf8').on('data', (chunk) => {
        terminal.write(chunk)
        output = (output + chunk).slice(-96 * 1024)
      })
    }
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}

async function publishInstaller(stage, output) {
  const source = path.join(stage, installerName)
  const handle = await open(source, 'r')
  try {
    const magic = Buffer.alloc(2)
    await handle.read(magic)
    if (magic.toString('ascii') !== 'MZ' || (await handle.stat()).size < 1024 * 1024) {
      throw new Error('NSIS did not produce a complete Windows installer.')
    }
  } finally {
    await handle.close()
  }
  const destination = path.join(output, installerName)
  await rename(source, destination)
  console.log(`\nInstaller ready: ${destination}`)
}

async function packageNsis({
  requestedOutput = path.resolve(process.env.INSTALLR_RELEASE_DIR || 'release'),
  build = compile,
} = {}) {
  await mkdir(requestedOutput, { recursive: true })
  const output = await realpath(requestedOutput)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const stage = await mkdtemp(path.join(output, '.nsis-'))
    try {
      const result = await build(stage)
      if (result.code === 0) {
        await publishInstaller(stage, output)
        return
      }
      if (!isNsisOutputError(result.output) || attempt === 3) {
        throw new Error(`NSIS packaging failed with exit code ${result.code}.`)
      }
      console.warn('MakeNSIS could not write its output. Retrying in a new build directory.')
    } finally {
      const resolvedStage = await realpath(stage).catch(() => null)
      if (resolvedStage && path.dirname(resolvedStage) === output && path.basename(resolvedStage).startsWith('.nsis-')) {
        await rm(resolvedStage, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 }).catch((error) => {
          console.warn(`Could not remove staging directory ${resolvedStage}: ${error.message}`)
        })
      }
    }
  }
}

if (require.main === module) {
  packageNsis().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { isNsisOutputError, packageNsis }
