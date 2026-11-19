const { spawn } = require('node:child_process')
const { join } = require('node:path')

const powerShell = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe'
const winGet = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')
  : 'winget.exe'

function startCommand(file, args, { timeoutMs = 0, maxOutput = 96 * 1024 } = {}) {
  const child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false
  let timedOut = false
  let stdout = ''
  let stderr = ''
  let truncated = false

  const append = (previous, next) => {
    const combined = previous + next
    truncated ||= combined.length > maxOutput
    return combined.slice(-maxOutput)
  }
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout = append(stdout, chunk) })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = append(stderr, chunk) })
  child.once('exit', () => { exited = true })

  const done = new Promise((resolve) => {
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true
      child.kill()
      // A descendant can inherit these streams and keep close pending.
      child.stdout.destroy()
      child.stderr.destroy()
    }, timeoutMs) : null

    const finish = (code, error) => {
      clearTimeout(timer)
      exited = true
      const output = [
        timedOut && 'Command timed out.',
        truncated && 'Earlier command output was truncated.',
        stdout.trim(),
        stderr.trim(),
        error?.message,
      ].filter(Boolean).join('\n')
      resolve({ success: !timedOut && !error && code === 0, code: code ?? -1, output, stdout, stderr, timedOut, truncated, errorCode: error?.code })
    }
    child.once('error', (error) => finish(null, error))
    child.once('close', (code) => finish(code))
  })

  async function stop() {
    if (exited || !child.pid) return { stopped: false, message: 'The command has already exited.' }
    const systemRoot = process.env.SystemRoot
    const taskkill = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill.exe'
    const result = await runCommand(taskkill, ['/PID', String(child.pid), '/T', '/F'], { timeoutMs: 8000 })
    return result.success
      ? { stopped: true }
      : { stopped: false, message: result.output || 'Windows could not stop the process tree.' }
  }

  return { done, stop }
}

function runCommand(file, args, options) {
  return startCommand(file, args, { timeoutMs: 20_000, ...options }).done
}

function powerShellArgs(command, { custom = false } = {}) {
  const script = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$ErrorActionPreference = 'Stop'\n" +
    command + (custom ? '\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }' : '')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

module.exports = { startCommand, runCommand, powerShell, powerShellArgs, winGet }
