const { performance } = require('node:perf_hooks')
const { createInventory } = require('../electron/inventory.cjs')
const { runCommand, winGet } = require('../electron/process.cjs')
const catalog = require('../electron/catalog.json')

async function measure() {
  for (let trial = 1; trial <= 3; trial++) {
    let commands = 0
    const inventory = createInventory({
      run(file, args, options) {
        commands++
        // Keep benchmarking read-only even when a source has pending agreements.
        return runCommand(file, file === winGet ? args.filter((arg) => arg !== '--accept-source-agreements') : args, options)
      },
    })
    const start = performance.now()
    const result = await inventory.getAppsInfo(catalog)
    const freshMs = performance.now() - start
    const numFreshCommands = commands
    const resolved = result.checkingUnmatched ? await inventory.getAppsInfo(catalog, undefined, true) : result
    const resolvedMs = performance.now() - start
    const numResolvedCommands = commands

    const cachedStart = performance.now()
    await inventory.getAppsInfo(catalog)
    const cachedMs = performance.now() - cachedStart
    console.log(JSON.stringify({
      trial,
      packages: catalog.length,
      freshMs: Math.round(freshMs),
      resolvedMs: Math.round(resolvedMs),
      cachedMs: Number(cachedMs.toFixed(2)),
      freshCommands: numFreshCommands,
      resolvedCommands: numResolvedCommands,
      cachedCommands: commands - numResolvedCommands,
      updates: resolved.apps.filter((entry) => entry.status === 'update-available').length,
      issue: result.issue,
    }))
    if (result.issue) process.exitCode = 1
  }
}

measure().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
