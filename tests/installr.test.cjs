const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, readFile, rm, rmdir, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createInventory, parseWingetList, registryMatch, packageId } = require('../electron/inventory.cjs')
const { createJournal, createInstallQueue, resultFor } = require('../electron/install-queue.cjs')
const { runCommand, winGet } = require('../electron/process.cjs')
const { isNsisOutputError, packageNsis } = require('../scripts/package-nsis.cjs')
const { version } = require('../package.json')
const catalog = require('../electron/catalog.json')

const example = { id: 'example', kind: 'winget', name: 'Example App', wingetId: 'Example.App' }
const custom = { id: 'custom-test', kind: 'custom', name: 'Custom test', customCommand: 'Write-Output "test"' }
const ok = (stdout) => ({ success: true, code: 0, stdout, stderr: '', output: stdout })
const missing = { ...ok('No installed package found.'), success: false, code: 0x8A150014 | 0 }
const offline = { ...ok('Source unavailable.'), success: false, code: -1 }
const widths = [42, 22, 15, 14]
const line = (...columns) => columns.map((cell, index) => widths[index] ? cell.padEnd(widths[index]) : cell).join('').trimEnd()
const german = (...rows) => [
  '  ▉▉▉ 1.0 MB / 2 MB',
  line('Name', 'ID', 'Version', 'Verfügbar', 'Quelle'),
  '-'.repeat(101),
  ...rows.map((row) => line(...row)),
].join('\r\n')
const inventoryTable = german(['Example App', 'Example.App', '1.2.3-beta.1', '1.2.3', 'winget'])

test('bulk output uses WinGet upgrade eligibility and preserves empty version columns', () => {
  const input = german(
    ['Example App', 'Example.App', '1.2.3-beta.1', '1.2.3', 'winget'],
    ['Other App', 'Other.App', '3.0', '', 'winget'],
    ['Microsoft Store App', '9EXAMPLE', 'Unbekannt', '', 'msstore'],
  )
  const { rows, complete } = parseWingetList(ok(input))
  assert.equal(complete, true)
  assert.deepEqual(rows.map(({ id, currentVersion, availableVersion, source }) => [id, currentVersion, availableVersion, source]), [
    ['Example.App', '1.2.3-beta.1', '1.2.3', 'winget'],
    ['Other.App', '3.0', null, 'winget'],
    ['9EXAMPLE', null, null, 'msstore'],
  ])
})

test('narrow and truncated table output can resolve an exact query', () => {
  const narrow = ok('Name ID      Version\r\n--------------------\r\nDemo Foo.Bar 1.0')
  assert.equal(parseWingetList(narrow).rows[0].currentVersion, '1.0')
  const old = ok(german(['Example App', 'Example.A…', '1.4', '1.5', 'winget']))
  assert.equal(parseWingetList(old).rows[0].truncated, true)
  assert.equal(parseWingetList(old, 'Example.App').rows[0].id, 'Example.App')
})

test('WinGet errors and partial inventory remain distinct from a package missing', () => {
  assert.equal(parseWingetList(missing).complete, true)
  assert.equal(parseWingetList(offline).complete, false)
  assert.equal(parseWingetList(ok('Anmeldung fehlgeschlagen.\r\n' + inventoryTable)).complete, false)
  assert.equal(parseWingetList({ ...missing, stdout: 'A source failed.\r\nNo installed package found.' }).complete, false)
})

test('catalog IDs are unique and point to an allowed source', () => {
  assert.equal(new Set(catalog.map((app) => app.id)).size, catalog.length)
  assert.equal(new Set(catalog.map((app) => app.wingetId.toLowerCase())).size, catalog.length)
  assert(catalog.every((app) => packageId.test(app.wingetId) && (!app.source || app.source === 'msstore')))
})

test('registry matches exact names and the specific Visual C++ architecture', () => {
  const entry = { DisplayName: 'Microsoft Visual C++ v14 Redistributable (x64) - 14.40', DisplayVersion: '14.40', Publisher: 'Microsoft Corporation' }
  assert.deepEqual(registryMatch({ ...example, wingetId: 'Microsoft.VCRedist.2015+.x64' }, [entry]), { found: true, version: '14.40' })
  assert.equal(registryMatch({ ...example, wingetId: 'Microsoft.VCRedist.2015+.x86' }, [entry]).found, false)
  assert.equal(registryMatch(example, [{ DisplayName: 'Example App Helper' }]).found, false)
})

test('concurrent inventory requests share a bounded snapshot and cache hits start no processes', async () => {
  let commands = 0
  let clock = 1000
  const inventory = createInventory({ now: () => clock, run: async (file) => {
    commands++
    return ok(file === winGet ? inventoryTable : '[]')
  } })
  const values = await Promise.all([
    inventory.getAppsInfo([example]), inventory.getAppsInfo([example], { maxAge: 0 }),
  ])
  assert.equal(commands, 3)
  assert.equal(values[0].apps[0].status, 'update-available')
  assert.deepEqual(values[0], values[1])
  clock++
  assert.equal((await inventory.getAppsInfo([example])).checkedAt, values[0].checkedAt)
  assert.equal(commands, 3)
  inventory.invalidate()
  assert.equal((await inventory.getAppsInfo([example])).checkedAt, clock)
  assert.equal(commands, 6)
})

test('plain list can show an update that WinGet pins block', async () => {
  const inventory = createInventory({ run: async (file, args) => {
    if (file !== winGet) return ok('[]')
    return args.includes('--upgrade-available') ? ok('Ein Paket wird durch einen Pin blockiert.') : ok(inventoryTable)
  } })
  const snapshot = await inventory.getSnapshot()
  assert.equal((await inventory.getAppsInfo([example])).apps[0].status, 'update-blocked')
  assert.equal((await inventory.getInstallInfo(example, snapshot)).status, 'update-blocked')
})

test('eligible upgrade lists include explicit upgrades and ignore localized summaries', () => {
  const secondTable = german(['Manual upgrade', 'Vendor.Manual', '1.0', '1.1', 'winget']).split('\r\n').slice(1).join('\r\n')
  const stdout = inventoryTable + '\r\n41 Aktualisierungen verfügbar.\r\nEinzelne Upgrades\r\n' + secondTable
  const report = parseWingetList(ok(stdout), undefined, { upgradesOnly: true })
  assert.equal(report.complete, true)
  assert.deepEqual(report.rows.map((row) => row.id), ['Example.App', 'Vendor.Manual'])
})

test('source failures are unknown in the catalog and exact reads can resolve a selected app', async () => {
  const calls = []
  const inventory = createInventory({ run: async (file, args) => {
    calls.push(args)
    if (file !== winGet) return ok('[]')
    return args.includes('--id') ? ok(inventoryTable) : offline
  } })
  const definition = { ...example, source: 'winget' }
  assert.equal((await inventory.getAppsInfo([definition])).apps[0].isInstalled, null)
  assert.equal((await inventory.getInstallInfo(definition, await inventory.getSnapshot())).status, 'update-available')
  assert.deepEqual(calls.at(-1).slice(-5), ['--id', 'Example.App', '--exact', '--source', 'winget'])
})

test('an unknown version remains installed and can be upgraded only by explicit policy', async () => {
  const inventory = createInventory({ run: async (file) => ok(file === winGet
    ? german(['Example App', 'Example.App', 'Unknown', '', 'winget']) : '[]') })
  const info = await inventory.getInstallInfo(example, await inventory.getSnapshot())
  assert.equal(info.status, 'unknown')
  assert.equal(info.isInstalled, true)
  assert.equal(info.canUpgradeUnknown, true)
})

test('registry-only matches get bounded background checks that the install queue can reuse', async () => {
  const calls = []
  const inventory = createInventory({ run: async (file, args) => {
    calls.push(args)
    if (file !== winGet) return ok(JSON.stringify([{ DisplayName: 'Example App', DisplayVersion: '1.0' }]))
    return args.includes('--id') ? ok(inventoryTable) : missing
  } })
  const initial = await inventory.getAppsInfo([example])
  assert.equal(initial.checkingUnmatched, true)
  assert.equal(initial.apps[0].status, 'unknown')
  assert.equal(calls.length, 3)
  const snapshot = await inventory.getSnapshot()
  const [catalogInfo, installInfo] = await Promise.all([
    inventory.getAppsInfo([example], undefined, true), inventory.getInstallInfo(example, snapshot),
  ])
  assert.equal(catalogInfo.checkingUnmatched, false)
  assert.equal(catalogInfo.apps[0].status, 'update-available')
  assert.deepEqual(catalogInfo.apps[0], installInfo)
  assert.equal(calls.length, 5)
})

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

function memoryJournal(batches = []) {
  let stored = structuredClone(batches)
  return {
    load: async () => structuredClone(stored),
    save: async (value) => { stored = structuredClone(value) },
  }
}

function mockInventory(status = 'update-available') {
  return {
    getSnapshot: async () => ({}),
    getInstallInfo: async () => ({ status, isInstalled: status !== 'not-installed' }),
    invalidate() {},
  }
}

test('queue shares a preflight and runs the upgrade identified by the inventory', async () => {
  let reads = 0
  const inventory = mockInventory()
  inventory.getSnapshot = async () => { reads++ }
  const calls = []
  const queue = createInstallQueue({
    inventory, journal: memoryJournal(),
    start(file, args) {
      calls.push({ file, args })
      return { done: Promise.resolve(ok('Installed')) }
    },
  })
  const result = await queue.install([example, { ...example, id: 'next', wingetId: 'Example.Next' }], { mode: 'interactive', scope: 'user' })
  assert.equal(reads, 1)
  assert.deepEqual(result.jobs.map((job) => job.result.outcome), ['updated', 'updated'])
  assert.equal(calls[0].file, winGet)
  assert(calls[0].args.includes('--interactive'))
  assert.equal(calls[0].args[0], 'upgrade')
  assert.equal(calls[0].args.at(-1), 'user')
})

test('concurrent batches are rejected and Skip waits for the current PowerShell process to exit', async () => {
  const running = deferred()
  const command = deferred()
  const finishedStopping = deferred()
  let starts = 0
  const queue = createInstallQueue({
    inventory: mockInventory(), journal: memoryJournal(),
    onChange(p) { if (p.job?.phase === 'running') running.resolve(p) },
    start() {
      starts++
      return { done: command.promise, stop: () => finishedStopping.promise }
    },
  })
  const batch = queue.install([custom, { ...custom, id: 'custom-second' }])
  const progress = await running.promise
  await assert.rejects(queue.install([custom]), /already running/)
  assert.equal((await queue.skip('stale-token')).accepted, false)
  const stopped = queue.skip(progress.job.token)
  assert.equal(queue.cancelRemaining(progress.batchId), true)
  finishedStopping.resolve({ stopped: true })
  assert.equal((await stopped).accepted, true)
  assert.equal(queue.isActive(), true)
  command.resolve({ ...offline, code: 1 })
  const result = await batch
  assert.deepEqual(result.jobs.map((job) => job.result.outcome), ['skipped', 'not-run'])
  assert.equal(starts, 1)
  assert.equal(queue.isActive(), false)
})

test('failed cancellation preserves the actual installer outcome', async () => {
  const running = deferred()
  const command = deferred()
  const queue = createInstallQueue({
    inventory: mockInventory(), journal: memoryJournal(),
    onChange(p) { if (p.job?.phase === 'running') running.resolve(p) },
    start: () => ({ done: command.promise, stop: async () => ({ stopped: false, message: 'Access denied' }) }),
  })
  const batch = queue.install([custom])
  const progress = await running.promise
  assert.deepEqual(await queue.skip(progress.job.token), { accepted: false, message: 'Access denied' })
  command.resolve(ok('finished'))
  assert.equal((await batch).jobs[0].result.outcome, 'custom-complete')
})

test('checkpoint failures prevent a new installer from launching', async () => {
  const store = memoryJournal()
  const save = store.save
  let writes = 0
  store.save = async (value) => {
    if (++writes === 2) throw new Error('Disk full')
    return save(value)
  }
  const queue = createInstallQueue({
    inventory: mockInventory(), journal: store,
    start() { assert.fail('An unrecorded installer must not start') },
  })
  const batch = await queue.install([custom])
  assert.equal(batch.jobs[0].result.outcome, 'not-run')
  assert.match(batch.issue, /Disk full/)
})

test('restart recovers an incomplete journal without replaying a custom command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installr-test-'))
  try {
    const journal = createJournal(join(root, 'history.json'))
    await journal.save([{
      id: 'prior-batch', startedAt: 100, jobs: [
        { id: 'custom-done', name: 'Done', token: 'done', phase: 'done', result: { outcome: 'custom-complete', output: 'completed' } },
        { id: 'custom-interrupted', name: 'Interrupted', token: 'active', phase: 'running' },
        { id: 'custom-pending', name: 'Pending', token: 'pending', phase: 'pending' },
      ],
    }])
    const queue = createInstallQueue({ inventory: mockInventory(), journal, start: () => assert.fail('Must not replay') })
    const snapshot = await queue.state()
    assert.equal(snapshot.activeBatch, null)
    assert.deepEqual(snapshot.history[0].jobs.map((job) => job.result.outcome), ['custom-complete', 'interrupted', 'not-run'])
    assert.equal((await journal.load())[0].finishedAt, snapshot.history[0].finishedAt)
  } finally {
    await rm(join(root, 'history.json'), { force: true })
    await rmdir(root)
  }
})

test('signed HRESULTs and reboot results retain their WinGet meaning', () => {
  assert.equal(resultFor('upgrade', { ...offline, code: 0x8A15002B | 0 }).outcome, 'up-to-date')
  assert.equal(resultFor('upgrade', { ...offline, code: 0x8A150068 | 0 }).outcome, 'blocked')
  assert.equal(resultFor('upgrade', { ...offline, code: 0x8A150109 }).outcome, 'reboot-required')
  assert.equal(resultFor('custom', { ...offline, code: 3010 }).outcome, 'reboot-required')
  assert.equal(resultFor('upgrade', { ...offline, code: 0x8A15010A | 0 }).retryAfterReboot, true)
  assert.equal(resultFor('install', { ...offline, code: 0x8A15010C | 0 }).outcome, 'skipped')
  assert.equal(resultFor('install', { ...offline, code: 1223 }).outcome, 'skipped')
})

test('a reboot result records remaining apps without launching them', async () => {
  const journal = memoryJournal()
  let launches = 0
  const queue = createInstallQueue({
    inventory: mockInventory(), journal,
    start: () => {
      launches++
      return { done: Promise.resolve({ ...offline, code: 3010 }) }
    },
  })
  const batch = await queue.install([custom, example])
  assert.equal(launches, 1)
  assert.deepEqual(batch.jobs.map((job) => job.result.outcome), ['reboot-required', 'not-run'])
  assert.match((await journal.load())[0].jobs[1].result.output, /Restart Windows/)
})

test('NSIS retry detection only matches a MakeNSIS output write failure', () => {
  assert.equal(isNsisOutputError("Bin\\makensis.exe: Error writing output: Can't open output file"), true)
  assert.equal(isNsisOutputError('makensis.exe: Error in script, unknown instruction'), false)
  assert.equal(isNsisOutputError('the signing service cannot open output file'), false)
})

test('an NSIS write failure retries in a new directory and publishes only the successful output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installr-nsis-test-'))
  const name = `Installr-Setup-${version}.exe`
  const destination = join(root, name)
  const directories = new Set()
  try {
    await writeFile(destination, 'previous output')
    await packageNsis({
      requestedOutput: root,
      async build(stage) {
        directories.add(stage)
        assert.equal(await readFile(destination, 'utf8'), 'previous output')
        if (directories.size === 1) {
          await writeFile(join(stage, name), 'incomplete')
          return { code: 1, output: "makensis.exe: Can't open output file" }
        }
        const file = Buffer.alloc(1024 * 1024)
        file.write('MZ')
        await writeFile(join(stage, name), file)
        return { code: 0, output: '' }
      },
    })
    assert.equal(directories.size, 2)
    assert.equal((await readFile(destination)).subarray(0, 2).toString(), 'MZ')
  } finally {
    await rm(destination, { force: true })
    await rmdir(root)
  }
})

test('command runner caps output, preserves UTF-8, and reports a timeout', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("a".repeat(1000) + "Grüße")'], { maxOutput: 100 })
  assert.equal(result.truncated, true)
  assert.equal(result.stdout.length, 100)
  assert(result.stdout.endsWith('Grüße'))
  const hanging = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 100 })
  assert.equal(hanging.timedOut, true)
  assert.equal(hanging.success, false)
})
