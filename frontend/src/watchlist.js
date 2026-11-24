import { useSyncExternalStore } from 'react'

import { staffOf } from './benchmarking/factors.js'

// A browser-only watchlist: firms someone follows, a private note on each,
// and the figures the firm reported when they started following it, so a
// later visit can say what has changed since. Nothing leaves the browser —
// there is no account and no server — which is also why it is per device.
//
// Stored under one versioned key. Every read is defensive: storage can be
// missing (private mode, blocked site data), full, or hold a value written
// by an older version of this code or by hand.

export const STORAGE_KEY = 'od.watchlist.v1'
export const MAX_NOTE = 4000
export const MAX_ENTRIES = 500

// The fields a baseline keeps: what material-change detection compares.
const BASELINE_FIELDS = [
  'aum_total',
  'aum_discretionary',
  'employees_total',
  'accounts_total',
  'disciplinary_flag_count',
  'affil_count',
  'fee_pct_of_aum',
  'fee_performance_based',
  'fee_commissions',
  'broker_dealer',
]

export function baselineOf(firm, snapshotDate) {
  const b = { date: snapshotDate ?? null, employees_advisory: staffOf(firm) }
  for (const k of BASELINE_FIELDS) b[k] = firm[k] ?? null
  return b
}

const EMPTY = Object.freeze({ firms: {} })

/** Parse whatever is stored into { firms: { [crd]: entry } }, dropping anything malformed. */
export function parseStored(raw) {
  if (!raw) return EMPTY
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (!data || typeof data !== 'object' || typeof data.firms !== 'object' || data.firms == null) return EMPTY
  const firms = {}
  for (const [key, e] of Object.entries(data.firms)) {
    if (!/^\d{1,9}$/.test(key) || !e || typeof e !== 'object') continue
    firms[key] = {
      crd: Number(key),
      name: typeof e.name === 'string' ? e.name.slice(0, 200) : '',
      addedAt: typeof e.addedAt === 'string' ? e.addedAt : null,
      note: typeof e.note === 'string' ? e.note.slice(0, MAX_NOTE) : '',
      baseline: e.baseline && typeof e.baseline === 'object' ? e.baseline : null,
    }
  }
  return { firms }
}

// ---- store ----------------------------------------------------------------

const listeners = new Set()
let cache = null

function storage() {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read() {
  if (cache) return cache
  let raw = null
  try {
    raw = storage()?.getItem(STORAGE_KEY) ?? null
  } catch {
    raw = null
  }
  cache = parseStored(raw)
  return cache
}

function write(next) {
  cache = next
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ v: 1, firms: next.firms }))
  } catch {
    // Full or blocked: keep the in-memory copy so this visit still works.
  }
  listeners.forEach((l) => l())
}

function subscribe(listener) {
  listeners.add(listener)
  const onStorage = (e) => {
    if (e.key === STORAGE_KEY) {
      cache = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useWatchlist() {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}

export const isWatched = (list, crd) => Boolean(list.firms[String(crd)])

export function follow(firm, snapshotDate) {
  const current = read()
  if (current.firms[String(firm.crd)]) return
  if (Object.keys(current.firms).length >= MAX_ENTRIES) return
  write({
    firms: {
      ...current.firms,
      [String(firm.crd)]: {
        crd: firm.crd,
        name: firm.business_name || firm.legal_name || '',
        addedAt: new Date().toISOString(),
        note: '',
        baseline: baselineOf(firm, snapshotDate),
      },
    },
  })
}

export function unfollow(crd) {
  const current = read()
  if (!current.firms[String(crd)]) return
  const firms = { ...current.firms }
  delete firms[String(crd)]
  write({ firms })
}

export function setNote(crd, note) {
  const current = read()
  const entry = current.firms[String(crd)]
  if (!entry) return
  write({ firms: { ...current.firms, [String(crd)]: { ...entry, note: String(note).slice(0, MAX_NOTE) } } })
}

/** "Mark as reviewed": the current figures become the new baseline. */
export function resetBaseline(crd, firm, snapshotDate) {
  const current = read()
  const entry = current.firms[String(crd)]
  if (!entry || !firm) return
  write({ firms: { ...current.firms, [String(crd)]: { ...entry, baseline: baselineOf(firm, snapshotDate) } } })
}

// ---- material change detection --------------------------------------------

// Thresholds are deliberately coarse: Form ADV figures move with every
// amendment and market swing, and an alert on every 2% drift would bury the
// changes that matter.
export const AUM_CHANGE = 0.1
export const STAFF_CHANGE = 0.15
export const STAFF_MIN_DELTA = 2

const FEE_LABELS = {
  fee_pct_of_aum: 'percentage-of-AUM fees',
  fee_performance_based: 'performance-based fees',
  fee_commissions: 'commissions',
}

const rel = (now, then) => (then > 0 && now != null ? now / then - 1 : null)

/**
 * What changed between a baseline and the firm's current record:
 * [{ id, kind: 'record'|'business'|'status', text }]. `firm` null means the
 * firm is no longer in the current snapshot. Pure.
 */
export function detectChanges(baseline, firm) {
  if (!baseline) return []
  if (!firm) {
    return [
      {
        id: 'missing',
        kind: 'status',
        text: 'No longer in the current SEC snapshot. It may have withdrawn or changed its registration; check IAPD.',
      },
    ]
  }
  const out = []
  const aum = rel(firm.aum_total, baseline.aum_total)
  if (aum != null && Math.abs(aum) >= AUM_CHANGE) {
    out.push({
      id: 'aum',
      kind: 'business',
      text: `Regulatory AUM ${aum > 0 ? 'up' : 'down'} ${Math.round(Math.abs(aum) * 100)}% since you started following. AUM moves with markets, client flows and acquisitions; it is not investment performance.`,
    })
  }
  const staffNow = staffOf(firm)
  const staffThen = baseline.employees_advisory
  if (staffNow != null && staffThen != null) {
    const delta = staffNow - staffThen
    const r = rel(staffNow, staffThen)
    if (Math.abs(delta) >= STAFF_MIN_DELTA && r != null && Math.abs(r) >= STAFF_CHANGE) {
      out.push({
        id: 'staff',
        kind: 'business',
        text: `Advisory staff ${delta > 0 ? 'up' : 'down'} from ${staffThen.toLocaleString()} to ${staffNow.toLocaleString()}.`,
      })
    }
  }
  const dNow = firm.disciplinary_flag_count ?? 0
  const dThen = baseline.disciplinary_flag_count ?? 0
  if (dNow !== dThen) {
    out.push({
      id: 'disclosures',
      kind: 'record',
      text:
        dNow > dThen
          ? `Item 11 disclosures rose from ${dThen} to ${dNow}. A disclosure is a reason to read the record, not a finding of wrongdoing.`
          : `Item 11 disclosures fell from ${dThen} to ${dNow}; matters can drop off as they age or are resolved.`,
    })
  }
  if ((firm.affil_count ?? 0) !== (baseline.affil_count ?? 0)) {
    out.push({
      id: 'affiliations',
      kind: 'business',
      text: `Financial-industry affiliations changed from ${baseline.affil_count ?? 0} to ${firm.affil_count ?? 0} (Item 7.A).`,
    })
  }
  for (const [k, label] of Object.entries(FEE_LABELS)) {
    const then = baseline[k] === true
    const now = firm[k] === true
    if (then !== now) {
      out.push({
        id: k,
        kind: 'business',
        text: now ? `Now reports ${label} (Item 5.E).` : `No longer reports ${label} (Item 5.E).`,
      })
    }
  }
  if ((baseline.broker_dealer ?? null) !== (firm.broker_dealer ?? null)) {
    const describe = (v) =>
      v === 'registered' ? 'registered as a broker-dealer' : v === 'affiliated' ? 'affiliated with a broker-dealer' : 'no broker-dealer ties'
    out.push({
      id: 'broker_dealer',
      kind: 'business',
      text: `Broker-dealer status changed: was ${describe(baseline.broker_dealer)}, now ${describe(firm.broker_dealer)}.`,
    })
  }
  return out
}

/**
 * Changes between the firm's two most recent published quarters, from its
 * quarterly history (firm_history shard). Independent of when someone
 * followed the firm, so a new follower still sees recent movement. Pure.
 */
export function recentQuarterChanges(history) {
  if (!history?.quarters?.length) return []
  const idx = history.quarters.map((_, i) => i).filter((i) => history.aum_total?.[i] != null)
  if (idx.length < 2) return []
  const [a, b] = idx.slice(-2)
  const out = []
  const aum = rel(history.aum_total[b], history.aum_total[a])
  if (aum != null && Math.abs(aum) >= AUM_CHANGE) {
    out.push({ id: 'q-aum', kind: 'business', quarter: history.quarters[b], text: `Regulatory AUM ${aum > 0 ? 'up' : 'down'} ${Math.round(Math.abs(aum) * 100)}% quarter over quarter.` })
  }
  const d0 = history.disciplinary_flag_count?.[a]
  const d1 = history.disciplinary_flag_count?.[b]
  if (d0 != null && d1 != null && d1 > d0) {
    out.push({ id: 'q-disc', kind: 'record', quarter: history.quarters[b], text: `Item 11 disclosures rose from ${d0} to ${d1} quarter over quarter.` })
  }
  return out
}
