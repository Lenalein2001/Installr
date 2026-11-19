import type { CustomApp, InstallOptions } from './electron-api'

export type SelectionProfile = { id: string; name: string; appIds: string[] }

export const customAppsKey = 'installr.customApps.v1'
export const profilesKey = 'installr.selectionProfiles.v1'
export const settingsKey = 'installr.settings.v1'

export const defaultOptions: InstallOptions = {
  locale: '', scope: '', architecture: '', mode: 'silent', includeUnknownVersions: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function loadList<T extends { id: string }>(key: string, isEntry: (value: unknown) => value is T) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return { entries: [], invalid: false }
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const entries = [...new Map(parsed.filter(isEntry).map((entry) => [entry.id, entry])).values()]
      return { entries, invalid: entries.length !== parsed.length }
    }
  } catch {
    // Leave the stored value available for recovery.
  }
  return { entries: [], invalid: true }
}

export function isCustomApp(value: unknown): value is CustomApp {
  return isRecord(value) && value.kind === 'custom' && typeof value.name === 'string' &&
    Boolean(value.name.trim()) && value.name.length <= 100 &&
    typeof value.id === 'string' && /^custom-[\w-]{1,64}$/.test(value.id) &&
    typeof value.customCommand === 'string' && Boolean(value.customCommand.trim()) && value.customCommand.length <= 6000
}

export function isProfile(value: unknown): value is SelectionProfile {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' &&
    Array.isArray(value.appIds) && value.appIds.every((id) => typeof id === 'string')
}

export function loadSettings(): InstallOptions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(settingsKey) ?? 'null')
    if (!isRecord(parsed)) return defaultOptions
    return {
      locale: typeof parsed.locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(parsed.locale) ? parsed.locale : '',
      scope: parsed.scope === 'machine' || parsed.scope === 'user' ? parsed.scope : '',
      architecture: parsed.architecture === 'x64' || parsed.architecture === 'x86' || parsed.architecture === 'arm64' ? parsed.architecture : '',
      mode: parsed.mode === 'interactive' ? 'interactive' : 'silent',
      includeUnknownVersions: parsed.includeUnknownVersions === true,
    }
  } catch {
    return defaultOptions
  }
}

export function saveStorage(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}
