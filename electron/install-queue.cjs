const { readFile, writeFile, rename } = require('node:fs/promises')
const { randomUUID } = require('node:crypto')
const { startCommand, powerShell, powerShellArgs, winGet } = require('./process.cjs')
const { packageSource } = require('./inventory.cjs')

const maxHistory = 8
const rebootCodes = new Set([3010, 1641, 0x8A150109, 0x8A15010B])
const rebootBeforeInstall = 0x8A15010A
const cancelledCodes = new Set([1223, 1602, 0x800704C7, 0x8A150005, 0x8A15010C])
const noUpgrade = 0x8A15002B
const pinned = 0x8A150068
const alreadyInstalled = new Set([0x8A150061, 0x8A15010D])

function createJournal(file) {
  return {
    async load() {
      try {
        const data = JSON.parse(await readFile(file, 'utf8'))
        if (data?.version !== 1 || !Array.isArray(data.batches) || data.batches.some((batch) =>
          typeof batch?.id !== 'string' || !Number.isFinite(batch.startedAt) || !Array.isArray(batch.jobs) ||
          batch.jobs.some((job) => typeof job?.token !== 'string' || typeof job.name !== 'string'))) {
          throw new Error('Unrecognized install history format.')
        }
        return data.batches
      } catch (error) {
        if (error.code === 'ENOENT') return []
        if (error instanceof SyntaxError || error.message === 'Unrecognized install history format.') {
          await rename(file, `${file}.invalid-${Date.now()}`)
          return []
        }
        throw error
      }
    },
    async save(batches) {
      const temporary = `${file}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 1, batches }), { encoding: 'utf8', flush: true })
      await rename(temporary, file)
    },
  }
}

function wingetInstallArgs(action, definition, options) {
  const args = [
    action, '--id', definition.wingetId, '--exact', '--source', packageSource(definition),
    '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity',
    options.mode === 'interactive' ? '--interactive' : '--silent',
  ]
  if (options.locale) args.push('--locale', options.locale)
  if (options.scope) args.push('--scope', options.scope)
  if (options.architecture) args.push('--architecture', options.architecture)
  if (action === 'install') args.push('--no-upgrade')
  if (action === 'upgrade' && options.includeUnknownVersions) args.push('--include-unknown')
  return args
}

function resultFor(action, command) {
  const code = command.code >>> 0
  if (code === rebootBeforeInstall) {
    return { outcome: 'reboot-required', code, retryAfterReboot: true, output: 'Restart Windows, then retry this app.\n' + command.output }
  }
  if (rebootCodes.has(code)) return { outcome: 'reboot-required', code, output: command.output }
  if (cancelledCodes.has(code)) return { outcome: 'skipped', code, output: command.output || 'Windows cancelled the installer.' }
  if (action === 'upgrade' && code === noUpgrade) {
    return { outcome: 'up-to-date', code, output: command.output || 'WinGet found no applicable upgrade.' }
  }
  if (action !== 'custom' && code === pinned) {
    return { outcome: 'blocked', code, output: command.output || 'WinGet blocked the upgrade because the package is pinned.' }
  }
  if (action === 'install' && alreadyInstalled.has(code)) {
    return { outcome: 'up-to-date', code, output: command.output || 'WinGet reports that the package is installed.' }
  }
  const successOutcome = { install: 'installed', upgrade: 'updated', custom: 'custom-complete' }
  return {
    outcome: command.success ? successOutcome[action] : 'failed',
    code: command.code === -1 ? -1 : code,
    output: command.output || (command.success ? '' : 'The command failed without reporting details.'),
  }
}

function createInstallQueue({ inventory, journal, start = startCommand, onChange = () => {} }) {
  let history = []
  let active
  let historyError

  const loaded = journal.load().then(async (batches) => {
    history = batches.slice(0, maxHistory)
    let recovered = false
    for (const batch of history) {
      if (batch.finishedAt) continue
      recovered = true
      batch.finishedAt = Date.now()
      batch.issue = 'Installr closed during this batch. Review the interrupted job before running it again.'
      for (const job of batch.jobs) {
        if (job.result) continue
        job.result = job.phase === 'running'
          ? { outcome: 'interrupted', output: 'The installer may have made changes. Check its status before retrying.' }
          : { outcome: 'not-run', output: 'The batch ended before this app ran.' }
        job.phase = 'done'
      }
    }
    if (recovered) await journal.save(history)
  }).catch((error) => { historyError = error })

  function publish(job, batch = active?.record) {
    // A renderer can close or reload without interrupting the queue.
    try {
      onChange({
        batchId: batch.id,
        active: active?.record === batch,
        total: batch.jobs.length,
        completed: batch.jobs.filter((entry) => entry.result).length,
        job,
        issue: batch.issue,
        changed: batch.changed,
        cancelling: Boolean(active?.cancelRemaining),
      })
    } catch {
      // The journal remains available to the next renderer.
    }
  }

  async function checkpoint() {
    try {
      await journal.save(history)
      return true
    } catch (error) {
      active.record.issue = `Could not save install history. Remaining apps were stopped. ${error.message}`
      active.cancelRemaining = true
      return false
    }
  }

  async function execute(definition, options, snapshot) {
    let action = 'custom'
    if (definition.kind === 'winget') {
      const info = await inventory.getInstallInfo(definition, await snapshot())
      if (active.skipRequested) return { outcome: 'skipped', output: 'Skipped before the installer started.' }
      if (info.status === 'up-to-date') {
        return { outcome: 'up-to-date', output: 'WinGet lists the app as installed with no update available.' }
      }
      if (info.status === 'update-blocked') {
        return { outcome: 'blocked', output: 'WinGet lists a newer version but does not offer it as an upgrade. Check your WinGet pins.' }
      }
      if (info.status === 'unknown' && !(options.includeUnknownVersions && info.canUpgradeUnknown)) {
        return {
          outcome: 'blocked',
          output: info.isInstalled
            ? 'Windows reports this app as installed. WinGet could not confirm an applicable update.'
            : 'WinGet could not confirm an eligible install or upgrade. Refresh the inventory and check the package source and installed version.',
        }
      }
      action = info.isInstalled ? 'upgrade' : 'install'
    }

    const job = active.job
    job.phase = 'running'
    job.action = action
    if (!await checkpoint()) {
      return { outcome: 'not-run', output: 'The install could not be recorded before starting.' }
    }
    if (active.skipRequested) return { outcome: 'skipped', output: 'Skipped before the installer started.' }

    const args = action === 'custom'
      ? powerShellArgs(definition.customCommand, { custom: true })
      : wingetInstallArgs(action, definition, options)
    active.command = start(action === 'custom' ? powerShell : winGet, args, { maxOutput: 8192 })
    publish(job)
    const command = await active.command.done
    const stop = await active.stopRequest
    const result = resultFor(action, command)
    if (result.outcome === 'reboot-required') return result
    if (stop?.stopped) {
      return { outcome: 'skipped', output: 'Windows stopped the installer process tree. The app may have made changes before it stopped.' }
    }
    return result
  }

  async function install(definitions, options = {}) {
    if (active) throw new Error('An install batch is already running.')
    const record = {
      id: randomUUID(),
      startedAt: Date.now(),
      jobs: definitions.map(({ id, name }) => ({ id, name, token: randomUUID(), phase: 'pending' })),
    }
    active = { record, cancelRemaining: false }
    try {
      await loaded
      if (historyError) throw new Error(`Could not open install history. ${historyError.message}`)
      history = [record, ...history].slice(0, maxHistory)
      if (!await checkpoint()) throw new Error(record.issue)

      let sharedSnapshot
      const snapshot = () => (sharedSnapshot ||= inventory.getSnapshot({ maxAge: 15_000 }))
      let attempted = false
      let rebootRequired = false
      for (const [index, definition] of definitions.entries()) {
        const job = record.jobs[index]
        if (active.cancelRemaining || rebootRequired) {
          job.result = {
            outcome: 'not-run',
            output: rebootRequired ? 'Restart Windows before running this app.' : 'The batch stopped before this app ran.',
          }
        } else {
          Object.assign(active, { job, skipRequested: false, command: null, stopRequest: null })
          job.phase = 'checking'
          publish(job)
          try {
            job.result = await execute(definition, options, snapshot)
          } catch (error) {
            job.result = { outcome: 'failed', output: error.message }
          }
          if (active.command) {
            attempted = true
            if (definition.kind === 'custom') {
              inventory.invalidate()
              sharedSnapshot = null
            }
          }
          if (job.result.outcome === 'reboot-required') rebootRequired = true
        }
        job.phase = 'done'
        active.job = null
        await checkpoint()
        publish(job)
      }
      if (attempted) inventory.invalidate()
      record.changed = attempted
      record.finishedAt = Date.now()
      await checkpoint()
      return record
    } finally {
      active = null
      publish(undefined, record)
    }
  }

  async function skip(token) {
    const batch = active
    if (!batch?.job || batch.job.token !== token) return { accepted: false, message: 'That job has already finished.' }
    if (!batch.command) {
      batch.skipRequested = true
      return { accepted: true, message: 'The current job will be skipped before launching.' }
    }
    batch.stopRequest ||= batch.command.stop()
    const result = await batch.stopRequest
    if (!result.stopped && active === batch && batch.job?.token === token) batch.stopRequest = null
    return { accepted: result.stopped, message: result.stopped ? 'Windows stopped the installer process tree.' : result.message }
  }

  function cancelRemaining(batchId) {
    if (!active || active.record.id !== batchId) return false
    active.cancelRemaining = true
    publish(active.job)
    return true
  }

  return {
    install,
    skip,
    cancelRemaining,
    isActive: () => Boolean(active),
    async state() {
      await loaded
      return {
        activeBatch: active?.record ?? null,
        cancelling: Boolean(active?.cancelRemaining),
        history: history.filter((batch) => batch !== active?.record),
        issue: historyError?.message,
      }
    },
  }
}

module.exports = { createJournal, createInstallQueue, resultFor }
