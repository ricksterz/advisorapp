// Shareable methodology URLs: the active config rides in a compact
// base64url-JSON `?m=` param. Untouched presets encode as just their id;
// custom configs encode only the delta vs. the default preset. Decoding
// whitelists and clamps every field, so a bad or stale link degrades to the
// default methodology instead of breaking the page.

import { FACTORS } from './factors.js'
import { RISK_SIGNALS } from './screens.js'
import { PRESET_BY_ID, cloneConfig, defaultConfig, matchingPresetId } from './presets.js'

const QUERY_PARAM = 'm'

const toBase64Url = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64Url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/'))

const num = (v, min, max, fallback) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
const int = (v, min, max, fallback) => Math.round(num(v, min, max, fallback))

// Rebuild a config from untrusted partial input, field by field; anything
// missing, unknown, or out of range takes the default preset's value.
export function sanitizeConfig(raw) {
  const cfg = defaultConfig()
  for (const f of FACTORS) cfg.weights[f.id] = num(raw?.weights?.[f.id], 0, 1, cfg.weights[f.id] ?? 0)
  cfg.top.minAum = num(raw?.top?.minAum, 0, 1e15, cfg.top.minAum)
  cfg.top.minStaff = int(raw?.top?.minStaff, 0, 1e6, cfg.top.minStaff)
  cfg.top.maxDisclosures = int(raw?.top?.maxDisclosures, 0, 999, cfg.top.maxDisclosures)
  cfg.risk.minAum = num(raw?.risk?.minAum, 0, 1e15, cfg.risk.minAum)
  cfg.risk.threshold = num(raw?.risk?.threshold, 0, 1000, cfg.risk.threshold)
  for (const s of RISK_SIGNALS) {
    cfg.risk.points[s.id] = num(raw?.risk?.points?.[s.id], 0, 500, cfg.risk.points[s.id])
  }
  for (const k of Object.keys(cfg.cohorts)) cfg.cohorts[k] = Boolean(raw?.cohorts?.[k])
  return cfg
}

// Leaves that differ from `base`, keeping the nested shape; undefined = equal.
function diff(value, base) {
  if (typeof value !== 'object' || value == null || typeof base !== 'object' || base == null) {
    return Object.is(value, base) ? undefined : value
  }
  const out = {}
  let changed = false
  for (const k of new Set([...Object.keys(value), ...Object.keys(base)])) {
    const d = diff(value[k], base[k])
    if (d !== undefined) {
      out[k] = d
      changed = true
    }
  }
  return changed ? out : undefined
}

export function encodeConfig(config) {
  const presetId = matchingPresetId(config)
  const payload = presetId
    ? { p: presetId }
    : { d: diff(config, PRESET_BY_ID.default.config) ?? {} }
  return toBase64Url(JSON.stringify(payload))
}

export function decodeConfig(param) {
  try {
    const payload = JSON.parse(fromBase64Url(param))
    if (payload.p) {
      return PRESET_BY_ID[payload.p] ? cloneConfig(PRESET_BY_ID[payload.p].config) : null
    }
    return sanitizeConfig(payload.d ?? {})
  } catch {
    return null
  }
}

// Config carried by the current page URL, or null.
export function configFromLocation(search = window.location.search) {
  const param = new URLSearchParams(search).get(QUERY_PARAM)
  return param ? decodeConfig(param) : null
}

// Absolute URL reproducing the given view; the default methodology gets a
// clean URL with no param at all.
export function urlForConfig(config, href = window.location.href) {
  const url = new URL(href)
  if (matchingPresetId(config) === 'default') url.searchParams.delete(QUERY_PARAM)
  else url.searchParams.set(QUERY_PARAM, encodeConfig(config))
  return url.toString()
}
