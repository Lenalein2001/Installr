import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import catalog from '../electron/catalog.json'
import type {
  AppInfo, AppStatus, BuiltInApp, CustomApp, InstallApp, InstallBatch, InstallJob,
  InstallOptions, InstallProgress, InventoryState, Outcome, WinGetState,
} from './electron-api'
import {
  customAppsKey, defaultOptions, isCustomApp, isProfile, loadList, loadSettings,
  profilesKey, saveStorage, settingsKey,
} from './storage'
import './App.css'

const builtInApps = catalog.map((app): BuiltInApp => ({ ...app, kind: 'winget' }))
const unranked = Number.MAX_SAFE_INTEGER
const catalogPriority = (app: InstallApp) => app.kind === 'winget' ? app.priority ?? unranked : unranked
const categoryOptions = [...new Set(builtInApps.map((app) => app.category)), 'Custom']
  .sort((a, b) => a.localeCompare(b))
const statusLabels: Record<AppStatus, string> = {
  'update-available': 'Update available', 'update-blocked': 'Update blocked',
  'up-to-date': 'Installed', 'not-installed': 'Not installed', unknown: 'Unknown',
}
const statusColors: Record<AppStatus, string> = {
  'update-available': 'update', 'update-blocked': 'update-blocked',
  'up-to-date': 'installed', 'not-installed': 'not-installed', unknown: 'unknown',
}
const outcomes: Record<Outcome, string> = {
  installed: 'Installed', updated: 'Updated', 'custom-complete': 'Completed',
  'up-to-date': 'Already installed', 'reboot-required': 'Restart required',
  skipped: 'Skipped', blocked: 'Needs attention', failed: 'Failed',
  interrupted: 'Interrupted', 'not-run': 'Not run',
}
const canRetry = new Set<Outcome>(['failed', 'not-run', 'skipped', 'blocked'])
const isRetryable = (job: InstallJob) => job.result && (canRetry.has(job.result.outcome) || job.result.retryAfterReboot)
const isRemaining = (job: InstallJob) => job.result?.outcome === 'not-run' || job.result?.retryAfterReboot === true
const languages = [
  ['', 'System default'], ['en-US', 'English (US)'], ['de-DE', 'German'], ['fr-FR', 'French'],
  ['es-ES', 'Spanish'], ['it-IT', 'Italian'], ['ja-JP', 'Japanese'], ['pt-BR', 'Portuguese (Brazil)'],
  ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Simplified)'],
]
const toolTitles = {
  settings: 'Install settings',
  custom: 'Custom apps',
  profiles: 'Selection profiles',
  history: 'Install history',
}
type Tool = keyof typeof toolTitles

function planLabel(definition: InstallApp, info: AppInfo | undefined, options: InstallOptions) {
  if (definition.kind === 'custom') return 'Run PowerShell'
  if (info?.status === 'update-available' || (options.includeUnknownVersions && info?.canUpgradeUnknown)) return 'Upgrade'
  if (info?.status === 'not-installed') return 'Install'
  if (info?.status === 'up-to-date') return 'No update reported'
  if (info?.status === 'update-blocked') return 'Upgrade blocked by WinGet'
  if (info?.isInstalled) return 'Verify update with WinGet'
  return 'Check package'
}

function JobResults({ jobs }: { jobs: InstallJob[] }) {
  return (
    <div className="results-list">
      {jobs.map(({ token, name, result }) => result && (
        <details key={token} className="result-item">
          <summary>
            <strong>{name}</strong>
            <span className={result.outcome === 'failed' || result.outcome === 'blocked' ||
              result.outcome === 'interrupted' ? 'fail' : ''}>
              {outcomes[result.outcome]}
            </span>
          </summary>
          {result.code !== undefined && result.code !== 0 && (
            <p>Exit code {result.code === -1 ? 'unavailable' : '0x' + result.code.toString(16).toUpperCase()}</p>
          )}
          {result.output && <pre>{result.output}</pre>}
        </details>
      ))}
    </div>
  )
}

function ToolDialog({ tool, onClose, children }: { tool: Tool; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [])

  return (
    <dialog ref={dialog} className="tool-dialog" aria-labelledby="tool-title" onClose={onClose}>
      <header className="dialog-heading">
        <h2 id="tool-title">{toolTitles[tool]}</h2>
        <button type="button" onClick={() => dialog.current?.close()}>Close</button>
      </header>
      <div className="dialog-content">{children}</div>
    </dialog>
  )
}

function Settings({ options, disabled, onChange }: {
  options: InstallOptions
  disabled: boolean
  onChange: (options: InstallOptions) => void
}) {
  const set = <K extends keyof InstallOptions,>(key: K, value: InstallOptions[K]) => onChange({ ...options, [key]: value })
  return (
    <fieldset className="settings-grid" disabled={disabled}>
      <label>Language
        <select value={options.locale} onChange={(event) => set('locale', event.target.value)}>
          {!languages.some(([value]) => value === options.locale) && <option value={options.locale}>{options.locale}</option>}
          {languages.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </label>
      <label>Install scope
        <select value={options.scope} onChange={(event) => set('scope', event.target.value as InstallOptions['scope'])}>
          <option value="">WinGet default</option>
          <option value="user">Current user</option>
          <option value="machine">All users</option>
        </select>
      </label>
      <label>Architecture
        <select value={options.architecture} onChange={(event) => set('architecture', event.target.value as InstallOptions['architecture'])}>
          <option value="">Auto</option><option value="x64">x64</option><option value="x86">x86</option><option value="arm64">ARM64</option>
        </select>
      </label>
      <label>Install mode
        <select value={options.mode} onChange={(event) => set('mode', event.target.value as InstallOptions['mode'])}>
          <option value="silent">Silent</option>
          <option value="interactive">Show installers</option>
        </select>
      </label>
      <label className="checkbox-setting">
        <input type="checkbox" checked={options.includeUnknownVersions} onChange={(event) => set('includeUnknownVersions', event.target.checked)} />
        Allow upgrades when the installed version is unknown
      </label>
      <button type="button" onClick={() => onChange(defaultOptions)}>Reset defaults</button>
    </fieldset>
  )
}

function App() {
  const [customStorage] = useState(() => loadList(customAppsKey, isCustomApp))
  const [profileStorage] = useState(() => loadList(profilesKey, isProfile))
  const [customApps, setCustomApps] = useState<CustomApp[]>(() => customStorage.entries.map((item) => ({ ...item, category: 'Custom' })))
  const [profiles, setProfiles] = useState(profileStorage.entries)
  const [options, setOptions] = useState(loadSettings)
  const [admin, setAdmin] = useState<boolean | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [winget, setWinget] = useState<WinGetState | null>(null)
  const [wingetBusy, setWingetBusy] = useState(false)
  const [inventory, setInventory] = useState<InventoryState | null>(null)
  const [inventoryBusy, setInventoryBusy] = useState(false)
  const [inventoryError, setInventoryError] = useState('')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [status, setStatus] = useState('')
  const [tool, setTool] = useState<Tool | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [profileName, setProfileName] = useState('')
  const [customName, setCustomName] = useState('')
  const [customCommand, setCustomCommand] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [live, setLive] = useState<{ batchId: string; jobs: InstallJob[] } | null>(null)
  const [history, setHistory] = useState<InstallBatch[]>([])
  const [message, setMessage] = useState('')
  const [stopPending, setStopPending] = useState(false)
  const requestId = useRef(0)
  const wingetReady = useRef(false)
  const reviewHeading = useRef<HTMLHeadingElement>(null)
  const catalogScroll = useRef<HTMLDivElement>(null)
  const api = window.electronAPI
  const installing = launching || progress !== null

  const refresh = useCallback(async (force = false) => {
    const id = ++requestId.current
    setInventoryBusy(true)
    setInventoryError('')
    try {
      const data = await api.getAppsInfo(force)
      if (requestId.current !== id) return
      setInventory(data)
      setInventoryBusy(false)
      if (data.checkingUnmatched) {
        const enriched = await api.getAppsInfo(false, true)
        if (requestId.current === id) setInventory(enriched)
      }
    } catch (error) {
      if (requestId.current === id) {
        setInventoryError(String(error))
        setInventory((previous) => previous && { ...previous, checkingUnmatched: false })
      }
    } finally {
      if (requestId.current === id) setInventoryBusy(false)
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    let mounted = true
    void api.getAdminState().then((value) => { if (mounted) setAdmin(value) }).catch(() => {})
    void api.checkWinget().then((value) => {
      if (!mounted) return
      wingetReady.current = value.available
      setWinget(value)
      if (value.available) void refresh()
    }).catch((error: unknown) => { if (mounted) setWinget({ available: false, issue: String(error) }) })
    return () => { mounted = false }
  }, [api, refresh])

  useEffect(() => {
    if (!reviewing || tool) return
    reviewHeading.current?.scrollIntoView({ block: 'nearest' })
    reviewHeading.current?.focus({ preventScroll: true })
  }, [reviewing, tool])

  useEffect(() => {
    if (catalogScroll.current) catalogScroll.current.scrollTop = 0
  }, [category, query, status])

  useEffect(() => {
    if (!api) return
    let mounted = true
    let eventCount = 0
    const hydrate = async () => {
      const countAtRequest = eventCount
      try {
        const state = await api.getQueueState()
        if (!mounted || countAtRequest !== eventCount) return
        setHistory(state.history)
        if (state.issue) setMessage(state.issue)
        const batch = state.activeBatch
        if (batch) {
          const jobs = batch.jobs.filter((job) => job.result)
          setLive({ batchId: batch.id, jobs })
          setProgress({
            batchId: batch.id, active: true, completed: jobs.length, total: batch.jobs.length,
            cancelling: state.cancelling, job: batch.jobs.find((job) => job.phase === 'running' || job.phase === 'checking'),
          })
        }
      } catch (error) {
        if (mounted && countAtRequest === eventCount) setMessage(String(error))
      }
    }
    const unsubscribe = api.onInstallProgress((event) => {
      eventCount++
      if (!event.active) {
        setProgress(null)
        if (event.issue) setMessage(event.issue)
        void hydrate()
        if (event.changed && wingetReady.current) void refresh()
        return
      }
      setProgress(event)
      const job = event.job
      if (job?.result) {
        setLive((previous) => ({
          batchId: event.batchId,
          jobs: [...(previous?.batchId === event.batchId ? previous.jobs.filter((entry) => entry.token !== job.token) : []), job],
        }))
      }
    })
    void hydrate()
    return () => { mounted = false; unsubscribe() }
  }, [api, refresh])

  const apps = useMemo(() => [...builtInApps, ...customApps], [customApps])
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const app of apps) counts.set(app.category, (counts.get(app.category) ?? 0) + 1)
    return counts
  }, [apps])
  const infoById = useMemo(() => new Map(inventory?.apps.map((info) => [info.id, info])), [inventory])
  const selectedApps = useMemo(() => apps.filter((app) => selected.has(app.id)), [apps, selected])
  const updates = useMemo(() => builtInApps.filter((app) => infoById.get(app.id)?.status === 'update-available'), [infoById])
  const views = useMemo(() => {
    const searchTerms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const groups = new Map<string, InstallApp[]>()
    for (const app of apps) {
      if (category && category !== app.category) continue
      const info = infoById.get(app.id)
      if (status === 'selected' && !selected.has(app.id)) continue
      if (status === 'installed' && !info?.isInstalled) continue
      if ((status === 'update-available' || status === 'not-installed') && info?.status !== status) continue
      if (searchTerms.length) {
        const id = app.kind === 'winget' ? app.wingetId : app.id
        const searchText = `${app.name} ${id} ${app.category}`.toLowerCase()
        if (!searchTerms.every((term) => searchText.includes(term))) continue
      }
      const group = groups.get(app.category) || []
      if (!groups.has(app.category)) groups.set(app.category, group)
      group.push(app)
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (catalogPriority(a) - catalogPriority(b)) || a.name.localeCompare(b.name))
    }
    return groups
  }, [apps, category, infoById, query, selected, status])

  function persist(key: string, value: unknown) {
    try {
      saveStorage(key, value)
      return true
    } catch {
      setMessage('Installr could not save this change. Check your Windows profile storage and try again.')
      return false
    }
  }

  function addSelection(items: InstallApp[]) {
    setSelected((previous) => new Set([...previous, ...items.map((app) => app.id)]))
  }

  function clearFilters() {
    setQuery('')
    setCategory('')
    setStatus('')
  }

  function toggleSelection(id: string) {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const name = profileName.trim()
    if (!name || !selectedApps.length) return
    const appIds = selectedApps.map((app) => app.id)
    const previous = profiles.find((profile) => profile.name.toLowerCase() === name.toLowerCase())
    const next = previous
      ? profiles.map((profile) => profile.id === previous.id ? { ...profile, name, appIds } : profile)
      : [...profiles, { id: crypto.randomUUID(), name, appIds }]
    if (persist(profilesKey, next)) {
      setProfiles(next)
      setProfileName('')
    }
  }

  function saveCustom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!customName.trim() || !customCommand.trim()) return
    const item: CustomApp = {
      id: editing ?? 'custom-' + crypto.randomUUID(), kind: 'custom', category: 'Custom',
      name: customName.trim(), customCommand: customCommand.trim(),
    }
    const next = editing ? customApps.map((app) => app.id === editing ? item : app) : [...customApps, item]
    if (!persist(customAppsKey, next)) return
    setCustomApps(next)
    if (!editing) addSelection([item])
    setEditing(null)
    setCustomName('')
    setCustomCommand('')
  }

  function removeCustom(id: string) {
    const next = customApps.filter((app) => app.id !== id)
    if (!persist(customAppsKey, next)) return
    setCustomApps(next)
    setSelected((previous) => new Set([...previous].filter((value) => value !== id)))
    if (editing === id) {
      setEditing(null)
      setCustomName('')
      setCustomCommand('')
    }
  }

  async function checkWinGet(repair = false) {
    setWingetBusy(true)
    setMessage('')
    try {
      const value = await (repair ? api.repairWingetAlias() : api.checkWinget())
      wingetReady.current = value.available
      setWinget(value)
      if (value.available) await refresh(true)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setWingetBusy(false)
    }
  }

  async function launchBatch() {
    setReviewing(false)
    setLaunching(true)
    setLive(null)
    setMessage('')
    try {
      const batch = await api.installApps(selectedApps, options)
      setHistory((previous) => [batch, ...previous.filter((entry) => entry.id !== batch.id)].slice(0, 8))
      if (batch.issue) setMessage(batch.issue)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setLaunching(false)
    }
  }

  async function skipJob(token: string) {
    setStopPending(true)
    try {
      const outcome = await api.skipCurrentInstall(token)
      if (outcome.message) setMessage(outcome.message)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setStopPending(false)
    }
  }

  async function restart() {
    setRestarting(true)
    try {
      const result = await api.restartAsAdmin()
      if (result.message) setMessage(result.message)
    } catch (error) {
      setMessage(String(error))
    } finally {
      setRestarting(false)
    }
  }

  const visibleCount = [...views.values()].reduce((total, entries) => total + entries.length, 0)
  const job = progress?.job
  const installUnavailable = !winget?.available && selectedApps.some((app) => app.kind === 'winget')
  const inventoryMessage = inventoryError || inventory?.issue
  const latest = history[0]
  const latestNeedsRestart = latest?.jobs.some((entry) => entry.result?.outcome === 'reboot-required')
  const latestInterrupted = latest?.jobs.some((entry) => entry.result?.outcome === 'interrupted')
  const modeLabel = options.mode === 'silent' ? 'Silent' : 'Show installers'
  const scopeLabel = options.scope === 'machine' ? 'All users' : options.scope === 'user' ? 'Current user' : 'WinGet default scope'
  const selectedCount = selectedApps.length

  function reviewRetry(batch: InstallBatch, shouldReview = isRetryable) {
    setSelected(new Set(batch.jobs.filter((job) => shouldReview(job) && apps.some((app) => app.id === job.id)).map((job) => job.id)))
    setTool(null)
    setReviewing(true)
  }

  return (
    <main className="app-shell">
      <header className="app-bar">
        <div className="brand">
          <img src={import.meta.env.BASE_URL + 'installr.png'} alt="" width="28" height="28" />
          <h1>Installr</h1>
        </div>
        <nav className="toolbar app-tools" aria-label="Installr tools">
          <button type="button" onClick={() => setTool('settings')}>Settings</button>
          <button type="button" onClick={() => setTool('custom')}>Custom apps</button>
          <button type="button" onClick={() => setTool('profiles')}>Profiles</button>
          <button type="button" onClick={() => setTool('history')}>History</button>
        </nav>
      </header>

      <div className="notices">
        {!api && <p role="status" className="notice">Open Installr in the desktop app to use WinGet and PowerShell.</p>}
        {api && !winget && <p role="status" className="notice">Checking WinGet…</p>}
        {api && winget && !winget.available && (
          <section className="notice" aria-label="WinGet setup">
            <h2>WinGet setup</h2>
            <p>{winget.issue || 'WinGet is unavailable.'} Custom PowerShell apps and saved profiles are available.</p>
            <div className="toolbar">
              <button type="button" disabled={wingetBusy || installing} onClick={() => { void api.openAppInstaller().catch((error: unknown) => setMessage(String(error))) }}>Open App Installer in Store</button>
              <button type="button" disabled={wingetBusy || installing} onClick={() => void checkWinGet(true)}>Repair WinGet alias</button>
              <button type="button" disabled={wingetBusy || installing} onClick={() => void checkWinGet()}>Check again</button>
            </div>
            {wingetBusy && <p role="status">Checking App Installer…</p>}
          </section>
        )}
        {message && !tool && <div className="notice toolbar"><span role="status">{message}</span><button type="button" onClick={() => setMessage('')}>Dismiss</button></div>}
        {!installing && latest && (latestNeedsRestart || latestInterrupted) && (
          <div className="notice toolbar">
            <span role="status">{latestNeedsRestart
              ? 'Windows requested a restart during the last batch. After restarting, review the remaining apps.'
              : 'The last batch was interrupted. Check the app that was running before selecting it again.'}</span>
            {latest.jobs.some((entry) => isRemaining(entry) && apps.some((app) => app.id === entry.id)) &&
              <button type="button" onClick={() => reviewRetry(latest, isRemaining)}>Review remaining apps</button>}
            <button type="button" onClick={() => setTool('history')}>View history</button>
          </div>
        )}
        {(customStorage.invalid || profileStorage.invalid) && <p role="status" className="notice">Some saved entries could not be read. Other valid entries were loaded.</p>}
      </div>

      <div className="workspace">
        <nav className="categories" aria-label="App categories">
          <h2>Categories</h2>
          <button type="button" aria-pressed={!category} onClick={() => setCategory('')}>
            All categories <span>{apps.length}</span>
          </button>
          {categoryOptions.map((name) => (
            <button type="button" key={name} aria-pressed={category === name} onClick={() => setCategory(name)}>
              {name} <span>{categoryCounts.get(name) ?? 0}</span>
            </button>
          ))}
        </nav>

        <section className="catalog" aria-labelledby="catalog-title">
          <div className="catalog-heading">
            <div className="heading-row">
              <h2 id="catalog-title">{category || 'App library'}</h2>
              <span role="status" className="app-count">{visibleCount} {visibleCount === 1 ? 'app' : 'apps'}</span>
            </div>
            <div className="catalog-filters">
              <input type="search" aria-label="Search apps" placeholder="Search apps or WinGet IDs" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select className="category-select" aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All categories</option>
                {categoryOptions.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <select aria-label="View" value={status} onChange={(event) => setStatus(event.target.value)}>
                <option value="">All apps</option>
                <option value="installed">Installed apps</option>
                <option value="update-available">Updates available</option>
                <option value="not-installed">Not installed</option>
                <option value="selected">Selected apps</option>
              </select>
            </div>
            <div className="toolbar catalog-actions">
              <button type="button" disabled={installing || !visibleCount} onClick={() => addSelection([...views.values()].flat())}>Select visible</button>
              <button type="button" disabled={installing || !updates.length} onClick={() => addSelection(updates)}>
                Select updates{updates.length ? ' (' + updates.length + ')' : ''}
              </button>
              <button type="button" className="refresh-button" disabled={!winget?.available || inventoryBusy || inventory?.checkingUnmatched || installing} onClick={() => void refresh(true)}>Refresh</button>
            </div>
            {inventoryMessage && <p role="status" className="notice inventory-notice">{inventoryMessage}</p>}
          </div>

          <div className="catalog-scroll" ref={catalogScroll}>
            {visibleCount ? (
              <table className="app-table" aria-labelledby="catalog-title">
                <thead>
                  <tr>
                    <th scope="col">Application</th>
                    <th scope="col">Installed</th>
                    <th scope="col">Available</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                {[...views.entries()].map(([name, entries]) => (
                  <tbody key={name}>
                    {!category && <tr className="table-group"><th scope="rowgroup" colSpan={4}>{name}</th></tr>}
                    {entries.map((entry) => {
                      const info = infoById.get(entry.id)
                      const state = info?.status ?? 'unknown'
                      const statusLabel = state === 'unknown' && info?.isInstalled ? 'Installed · update unverified' : statusLabels[state]
                      return (
                        <tr key={entry.id} className={selected.has(entry.id) ? 'selected-row' : undefined}>
                          <th scope="row">
                            <label className="app-label">
                              <input type="checkbox" aria-label={'Select ' + entry.name} checked={selected.has(entry.id)}
                                onChange={() => toggleSelection(entry.id)} disabled={installing} />
                              <span className="app-identity">
                                <strong>{entry.name}</strong>
                                {entry.kind === 'winget' && <small title={entry.wingetId}>{entry.wingetId}{entry.source === 'msstore' && ' · Microsoft Store'}</small>}
                              </span>
                            </label>
                          </th>
                          <td className="version">{info?.currentVersion || (info?.isInstalled ? 'Unknown' : '—')}</td>
                          <td className="version">{info?.remoteVersion || '—'}</td>
                          <td className={'app-status ' + statusColors[state]}>{entry.kind === 'custom' ? 'PowerShell' : statusLabel}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                ))}
              </table>
            ) : (
              <div className="empty-table">
                <p>{category === 'Custom' && !customApps.length ? 'No custom apps saved.' : 'No apps match these filters.'}</p>
                {category === 'Custom' && !customApps.length
                  ? <button type="button" onClick={() => setTool('custom')}>Manage custom apps</button>
                  : <button type="button" onClick={clearFilters}>Clear filters</button>}
              </div>
            )}
          </div>
        </section>

        <section className="workbench" aria-label={installing ? 'Install queue' : 'Selection'}>
          <div className="workbench-heading heading-row">
            {reviewing && !installing
              ? <h2 ref={reviewHeading} tabIndex={-1}>Review selection</h2>
              : <h2>{installing ? 'Install queue' : 'Selection'}</h2>}
            <span className="app-count">{installing
              ? (progress?.completed ?? 0) + ' / ' + (progress?.total ?? selectedCount)
              : selectedCount + ' ' + (selectedCount === 1 ? 'app' : 'apps')}</span>
          </div>
          <div className="workbench-content">
            {installing ? (
              <>
                <progress max={progress?.total || selectedCount || 1} value={progress?.completed ?? 0} aria-label="Completed jobs" />
                <p role="status" className="queue-state">{job?.phase === 'checking' ? 'Checking ' + job.name : job?.phase === 'running' ? 'Running ' + job.name : 'Preparing the next step…'}</p>
                {job?.phase === 'running' && job.action !== 'custom' && admin === false && (
                  <p className="muted">If Windows asks for approval, open the shield icon on the taskbar.</p>
                )}
                {progress && live?.batchId === progress.batchId && <JobResults jobs={live.jobs} />}
              </>
            ) : (
              <>
                <div className="selection-settings">
                  <span>{modeLabel} · {scopeLabel}{reviewing && <> · {options.architecture || 'Auto architecture'} · {options.locale || 'System language'}</>}</span>
                  <button type="button" className="text-button" onClick={() => setTool('settings')}>Change</button>
                </div>
                {!selectedCount && <p className="empty-selection">Select apps from the library to install or update them.</p>}
                {selectedCount > 0 && (
                  <ul className="selection-list">
                    {selectedApps.map((entry) => (
                      <li key={entry.id}>
                        <div>
                          <strong>{entry.name}</strong>
                          <span>{planLabel(entry, infoById.get(entry.id), options)}</span>
                          {reviewing && entry.kind === 'custom' && <details><summary>Show PowerShell command</summary><pre>{entry.customCommand}</pre></details>}
                        </div>
                        {!reviewing && <button type="button" className="remove-selection" aria-label={'Remove ' + entry.name + ' from selection'}
                          onClick={() => toggleSelection(entry.id)}>×</button>}
                      </li>
                    ))}
                  </ul>
                )}
                {reviewing && installUnavailable && <p role="status" className="notice">WinGet is unavailable. Clear WinGet apps from this selection or repair WinGet first.</p>}
                {latest && !reviewing && (
                  <details className="latest-results">
                    <summary>Latest batch results</summary>
                    <JobResults jobs={latest.jobs} />
                  </details>
                )}
              </>
            )}
          </div>
          <div className="workbench-actions toolbar">
            {installing ? (
              <>
                <button type="button" disabled={!job || job.phase === 'done' || stopPending} onClick={() => { if (job) void skipJob(job.token) }}>{stopPending ? 'Stopping…' : 'Skip current'}</button>
                <button type="button" disabled={!progress || progress.cancelling} onClick={() => {
                  if (progress) void api.cancelRemainingInstalls(progress.batchId).then((accepted) => {
                    if (!accepted) setMessage('The batch has already finished.')
                  }).catch((error: unknown) => setMessage(String(error)))
                }}>{progress?.cancelling ? 'Stopping after current app' : 'Cancel remaining'}</button>
              </>
            ) : reviewing ? (
              <>
                <button type="button" onClick={() => setReviewing(false)}>Back</button>
                <button type="button" className="primary" disabled={!api || !selectedCount || installUnavailable || wingetBusy || restarting} onClick={() => void launchBatch()}>Run batch</button>
              </>
            ) : (
              <>
                <button type="button" className="text-button" disabled={!selectedCount} onClick={() => setSelected(new Set())}>Clear</button>
                <button type="button" className="primary" disabled={!selectedCount} onClick={() => setReviewing(true)}>Review and install</button>
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="status-bar">
        <span role="status">
          {inventoryBusy ? 'Refreshing inventory…' : inventory?.checkingUnmatched ? 'Checking unmatched apps…' :
            inventory?.checkedAt ? 'Inventory checked ' + new Date(inventory.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) :
              inventoryError ? 'Inventory unavailable' : winget?.available ? 'Inventory pending' : winget ? 'WinGet unavailable' : 'Inventory unchecked'}
        </span>
        {admin === true && <span>Running as administrator</span>}
        {admin === false && <button type="button" className="text-button" disabled={installing || restarting || wingetBusy}
          onClick={() => void restart()}>{restarting ? 'Requesting elevation…' : 'Restart as administrator'}</button>}
      </footer>

      {tool && <ToolDialog tool={tool} onClose={() => setTool(null)}>
        {message && <div className="notice toolbar dialog-notice"><span role="status">{message}</span><button type="button" onClick={() => setMessage('')}>Dismiss</button></div>}
        {tool === 'settings' && <Settings options={options} disabled={installing}
          onChange={(next) => { if (persist(settingsKey, next)) setOptions(next) }} />}
        {tool === 'custom' && (
          <>
            <form className="stacked-form" onSubmit={saveCustom}>
              <label>App name<input required maxLength={100} value={customName} onChange={(event) => setCustomName(event.target.value)} disabled={installing} /></label>
              <label>PowerShell command<textarea required rows={4} maxLength={6000} value={customCommand} onChange={(event) => setCustomCommand(event.target.value)} disabled={installing} /></label>
              <div className="toolbar">
                <button type="submit" className="primary" disabled={installing}>{editing ? 'Save changes' : 'Add custom app'}</button>
                {editing && <button type="button" onClick={() => { setEditing(null); setCustomName(''); setCustomCommand('') }}>Cancel edit</button>}
              </div>
            </form>
            {customApps.map((entry) => <div className="profile-item" key={entry.id}>
              <strong>{entry.name}</strong>
              <div className="toolbar">
                <button type="button" disabled={installing} onClick={() => { setEditing(entry.id); setCustomName(entry.name); setCustomCommand(entry.customCommand) }}>Edit</button>
                <button type="button" disabled={installing} onClick={() => removeCustom(entry.id)}>Remove</button>
              </div>
            </div>)}
          </>
        )}
        {tool === 'profiles' && (
          <>
            <form className="toolbar profile-form" onSubmit={saveProfile}>
              <label>Profile name<input required maxLength={100} value={profileName} onChange={(event) => setProfileName(event.target.value)} disabled={installing} /></label>
              <button type="submit" className="primary" disabled={installing || !selectedCount}>Save selection</button>
            </form>
            {!selectedCount && <p className="muted">Select apps in the library to save a profile.</p>}
            {profiles.map((profile) => <div className="profile-item" key={profile.id}>
              <div><strong>{profile.name}</strong><p className="muted">{profile.appIds.length} apps</p></div>
              <div className="toolbar">
                <button type="button" disabled={installing} onClick={() => { setSelected(new Set(profile.appIds)); setTool(null) }}>Load</button>
                <button type="button" disabled={installing} onClick={() => {
                  const next = profiles.filter((entry) => entry.id !== profile.id)
                  if (persist(profilesKey, next)) setProfiles(next)
                }}>Delete</button>
              </div>
            </div>)}
          </>
        )}
        {tool === 'history' && (
          history.length ? history.map((batch) => <details className="history-batch" key={batch.id}>
            <summary><span>{new Date(batch.startedAt).toLocaleString()}</span><span>{batch.jobs.length} apps</span></summary>
            {batch.issue && <p role="status" className="notice">{batch.issue}</p>}
            <JobResults jobs={batch.jobs} />
            {batch.jobs.some((entry) => isRetryable(entry) && apps.some((app) => app.id === entry.id)) &&
              <button type="button" disabled={installing} onClick={() => reviewRetry(batch)}>Review retry</button>}
          </details>) : <p className="muted">No batches have run yet.</p>
        )}
      </ToolDialog>}
    </main>
  )
}

export default App
