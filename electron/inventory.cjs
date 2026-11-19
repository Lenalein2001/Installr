const { runCommand, powerShell, powerShellArgs, winGet } = require('./process.cjs')

const noMatch = 0x8A150014
// A fresh, registered WinGet source can still need to download its index.
const readOptions = { timeoutMs: 60_000, maxOutput: 4 * 1024 * 1024 }
const exactOptions = { ...readOptions, timeoutMs: 25_000 }
const listArgs = ['list', '--disable-interactivity', '--accept-source-agreements']
const maxBackgroundLookups = 12
const backgroundConcurrency = 3
const packageId = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/
const normalize = (value) => value.toLowerCase()
const knownVersion = (value) => /\d/.test(value) && !/[.…]$/.test(value)
const packageSource = (definition) => definition.source || 'winget'
const keyFor = (id, source) => `${normalize(id)}@${normalize(source)}`

function cleanLines(stdout) {
  // WinGet uses carriage returns and ANSI sequences for progress before the table.
  // eslint-disable-next-line no-control-regex
  return stdout.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/[\r\n]+/).map((line) => line.trimEnd()).filter(Boolean)
}

function isProgress(line) {
  return /^\s*[-/\\|█▒░▉▊▋▌▍▎▏▐■\s]+(?:[\d.,]+.*)?$/u.test(line) ||
    /^\s*\d{1,3}%\s*$/u.test(line)
}

function tableCells(line, columns) {
  // The Name column can contain wide characters. The remaining columns are
  // separated by the space following the package ID, even in narrow exact lookups.
  const idColumn = columns[1]
  const candidates = [...line.matchAll(/\S+/g)]
    .filter((match) => match.index + match[0].length > idColumn - 1 && match.index < columns[2])
  const idCell = candidates.find((match) => match.index === idColumn) ||
    candidates.find((match) => match[0].includes('.') && packageId.test(match[0])) ||
    candidates.at(-1)
  if (!idCell) return []
  const shift = idCell.index - idColumn
  return [
    line.slice(0, idCell.index).trim(),
    ...columns.slice(1).map((start, index) =>
      line.slice(start + shift, index + 2 < columns.length ? columns[index + 2] + shift : undefined).trim()),
  ]
}

function parseWingetList(result, exactId, { upgradesOnly = false } = {}) {
  const lines = cleanLines(result.stdout || '')
  if ((result.code >>> 0) === noMatch) {
    const diagnostics = lines.filter((line) => !isProgress(line))
    return { rows: [], complete: diagnostics.length <= 1 && !result.stderr?.trim() }
  }
  if (!result.success || result.truncated) return { rows: [], complete: false }

  const separators = lines.flatMap((line, index) => index && /^[-─━]{3,}$/.test(line) ? [index] : [])
  if (!separators.length) {
    // For upgrade-only lists, WinGet can succeed with a single localized "no upgrades" line.
    const diagnostics = lines.filter((line) => !isProgress(line))
    return { rows: [], complete: upgradesOnly && diagnostics.length <= 1 && !result.stderr?.trim() }
  }
  const warnings = lines.slice(0, separators[0] - 1).filter((line) => !isProgress(line))
  let complete = !result.stderr?.trim() && (!warnings.length || (upgradesOnly && warnings.length === 1))
  const rows = []

  for (const [index, separator] of separators.entries()) {
    const columns = [...lines[separator - 1].matchAll(/\S+/gu)].map((match) => match.index)
    if (columns.length < 3 || columns.length > 5) {
      complete = false
      continue
    }
    const end = index + 1 < separators.length ? separators[index + 1] - 1 : lines.length
    for (const line of lines.slice(separator + 1, end)) {
      if (isProgress(line)) continue
      const [, visibleId, version, fourth, fifth] = tableCells(line, columns)
      const truncatedId = visibleId?.replace(/(?:…|\.\.\.)$/, '')
      const id = exactId && truncatedId && truncatedId !== visibleId &&
        normalize(exactId).startsWith(normalize(truncatedId)) ? exactId : visibleId
      if (!id || !version) {
        if (!upgradesOnly) complete = false
        continue
      }
      const sourceOnly = columns.length === 4 && /^(winget|msstore)$/i.test(fourth)
      const availableVersion = !sourceOnly && fourth && knownVersion(fourth) ? fourth : null
      // Upgrade-only output may have localized footers and additional tables for
      // apps that only support explicit upgrades. Collect the package rows in all sections.
      if (upgradesOnly && (!availableVersion || !packageId.test(truncatedId))) continue
      rows.push({
        id,
        currentVersion: knownVersion(version) ? version : null,
        availableVersion,
        source: fifth || (sourceOnly ? fourth : null),
        truncated: id === visibleId && truncatedId !== visibleId,
      })
    }
  }
  return { rows, complete }
}

const registryQuery = String.raw`
$paths = @(
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$items = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
  Where-Object DisplayName |
  Select-Object DisplayName, DisplayVersion, Publisher)
ConvertTo-Json -InputObject $items -Compress
`

function parseRegistry(result) {
  if (!result.success || result.truncated) return []
  try {
    const entries = JSON.parse(result.stdout)
    return Array.isArray(entries) ? entries.filter((entry) => typeof entry?.DisplayName === 'string') : []
  } catch {
    return []
  }
}

function registryMatch(definition, entries) {
  const arch = /^Microsoft\.VCRedist\.2015\+\.(x86|x64)$/i.exec(definition.wingetId)?.[1]
  const names = (definition.registryNames || [definition.name]).map(normalize)
  const publisher = definition.registryPublisher && normalize(definition.registryPublisher)
  const matches = entries.filter((entry) => {
    if (typeof entry.DisplayName !== 'string') return false
    const name = normalize(entry.DisplayName.trim())
    if (arch) {
      return typeof entry.Publisher === 'string' && normalize(entry.Publisher) === 'microsoft corporation' &&
        /^microsoft visual c\+\+ (?:v14|2015(?:-20\d\d)?) redistributable/.test(name) &&
        name.includes(`(${arch})`)
    }
    if (names.includes(name)) return true
    // Some installers append their exact DisplayVersion to the registered name.
    // Require the catalog publisher for this fallback so editions and helpers stay distinct.
    if (!publisher || typeof entry.Publisher !== 'string' || normalize(entry.Publisher.trim()) !== publisher) return false
    const version = typeof entry.DisplayVersion === 'string' ? normalize(entry.DisplayVersion.trim()) : ''
    const suffix = ' ' + version
    return knownVersion(version) && name.endsWith(suffix) && names.includes(name.slice(0, -suffix.length).trimEnd())
  })
  const versions = new Set(matches.map((entry) => entry.DisplayVersion).filter((version) => typeof version === 'string'))
  return { found: matches.length > 0, version: versions.size === 1 ? [...versions][0] : null }
}

function indexRows(rows) {
  const index = new Map()
  for (const row of rows) {
    const key = keyFor(row.id, row.source || '')
    const group = index.get(key) || []
    group.push(row)
    index.set(key, group)
  }
  return index
}

function rowsFor(index, id, source) {
  return index.get(keyFor(id, source)) || index.get(keyFor(id, '')) || []
}

function indexUpgrades(result, exactId) {
  const parsed = parseWingetList(result, exactId, { upgradesOnly: true })
  return {
    index: indexRows(parsed.rows),
    // An older WinGet can truncate IDs. In that case an omitted ID is inconclusive.
    complete: parsed.complete && !parsed.rows.some((row) => row.truncated),
  }
}

function appInfo(definition, snapshot) {
  const info = { id: definition.id, status: 'unknown', isInstalled: null, currentVersion: null, remoteVersion: null }
  if (definition.kind !== 'winget') return info
  const id = definition.wingetId
  const source = packageSource(definition)
  const rows = rowsFor(snapshot.index, id, source)

  if (rows.length === 1) {
    const [row] = rows
    const eligible = rowsFor(snapshot.upgrades.index, id, source)
    let status = row.currentVersion && snapshot.complete ? 'up-to-date' : 'unknown'
    if (row.currentVersion && eligible.length === 1) status = 'update-available'
    else if (row.currentVersion && row.availableVersion) {
      // Plain "list" ignores pins. A newer manifest alone does not make it an eligible update.
      status = snapshot.upgrades.complete ? 'update-blocked' : 'unknown'
    }
    return {
      ...info,
      isInstalled: true,
      currentVersion: row.currentVersion,
      remoteVersion: eligible[0]?.availableVersion || row.availableVersion,
      canUpgradeUnknown: !row.currentVersion && snapshot.complete,
      status,
    }
  }
  if (rows.length > 1) return { ...info, isInstalled: true }

  const registry = registryMatch(definition, snapshot.registry)
  if (registry.found) return { ...info, isInstalled: true, currentVersion: registry.version }
  if (!snapshot.complete || snapshot.truncatedIds.some((prefix) => normalize(id).startsWith(prefix))) return info
  return { ...info, isInstalled: false, status: 'not-installed' }
}

function createInventory({ run = runCommand, now = Date.now } = {}) {
  let cached
  let pending
  let revision = 0

  async function read() {
    const [list, eligible, registry] = await Promise.all([
      run(winGet, listArgs, readOptions),
      run(winGet, [...listArgs, '--upgrade-available'], readOptions),
      run(powerShell, powerShellArgs(registryQuery), readOptions),
    ])
    const parsed = parseWingetList(list)
    const upgrades = indexUpgrades(eligible)
    return {
      complete: parsed.complete,
      upgrades,
      index: indexRows(parsed.rows),
      registry: parseRegistry(registry),
      resolved: new Map(),
      lookups: new Map(),
      truncatedIds: parsed.rows.filter((row) => row.truncated).map((row) => normalize(row.id.replace(/(?:…|\.\.\.)$/, ''))),
      checkedAt: now(),
      issue: parsed.complete && upgrades.complete ? null :
        list.timedOut || eligible.timedOut ? 'WinGet inventory timed out.' : 'WinGet returned an incomplete inventory or update list.',
    }
  }

  function getSnapshot({ maxAge = 120_000 } = {}) {
    if (pending) return pending
    if (cached && now() - cached.checkedAt < Math.min(maxAge, cached.issue ? 5000 : Infinity)) {
      return Promise.resolve(cached)
    }
    const startedAt = revision
    const operation = read().then((snapshot) => {
      if (revision === startedAt) cached = snapshot
      return snapshot
    }).finally(() => {
      if (pending === operation) pending = null
    })
    pending = operation
    return operation
  }

  function invalidate() {
    revision++
    cached = null
    pending = null
  }

  function infoFor(definition, snapshot) {
    return snapshot.resolved.get(definition.id) || appInfo(definition, snapshot)
  }

  function needsBackgroundLookup(definition, snapshot) {
    if (snapshot.issue || definition.kind !== 'winget' || snapshot.resolved.has(definition.id)) return false
    const info = appInfo(definition, snapshot)
    return info.status === 'unknown' && info.isInstalled && Boolean(info.currentVersion)
  }

  async function getAppsInfo(definitions, options, resolve = false) {
    const snapshot = await getSnapshot(options)
    const ambiguous = definitions.filter((definition) => needsBackgroundLookup(definition, snapshot))
    if (resolve && ambiguous.length) {
      const pendingDefinitions = ambiguous.slice(0, maxBackgroundLookups).values()
      await Promise.all(Array.from({ length: Math.min(ambiguous.length, backgroundConcurrency) }, async () => {
        for (const definition of pendingDefinitions) await getInstallInfo(definition, snapshot)
      }))
    }
    return {
      apps: definitions.map((definition) => infoFor(definition, snapshot)),
      checkedAt: snapshot.checkedAt,
      issue: snapshot.issue,
      checkingUnmatched: !resolve && ambiguous.length > 0,
    }
  }

  async function resolveExact(definition, snapshot, info) {
    const exact = ['--id', definition.wingetId, '--exact', '--source', packageSource(definition)]
    const result = await run(winGet, [...listArgs, ...exact], exactOptions)
    const parsed = parseWingetList(result, definition.wingetId)
    const index = indexRows(parsed.rows)
    const source = packageSource(definition)
    const needsUpgradeCheck = rowsFor(index, definition.wingetId, source).some((row) => row.availableVersion && row.currentVersion)
    const upgrades = needsUpgradeCheck
      ? indexUpgrades(await run(winGet, [...listArgs, '--upgrade-available', ...exact], exactOptions), definition.wingetId)
      : snapshot.upgrades
    const refined = appInfo(definition, { ...snapshot, index, upgrades, complete: parsed.complete, truncatedIds: [] })
    return refined.isInstalled !== true && info.isInstalled === true ? info : refined
  }

  function getInstallInfo(definition, snapshot) {
    const info = infoFor(definition, snapshot)
    if (info.status !== 'unknown' || snapshot.resolved.has(definition.id)) return Promise.resolve(info)
    if (snapshot.lookups.has(definition.id)) return snapshot.lookups.get(definition.id)
    const lookup = resolveExact(definition, snapshot, info).then((resolved) => {
      snapshot.resolved.set(definition.id, resolved)
      return resolved
    }).finally(() => snapshot.lookups.delete(definition.id))
    snapshot.lookups.set(definition.id, lookup)
    return lookup
  }

  return { getSnapshot, getAppsInfo, getInstallInfo, invalidate }
}

module.exports = { createInventory, parseWingetList, registryMatch, packageId, packageSource }
