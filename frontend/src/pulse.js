import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Industry Pulse aggregates (etl/pulse_stats.py) — precomputed at refresh
// time from quarterly point-in-time snapshots, served as one static file.
// Same fetch-once pattern as deal_flags.json / advisor_bios.json.
let pulsePromise = null
function fetchPulse() {
  pulsePromise ??= fetch(`${BASE}pulse_stats.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return pulsePromise
}

// undefined while loading; null when unavailable (dev fixture has no file).
export function usePulseStats() {
  const [stats, setStats] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchPulse().then((d) => {
      if (alive) setStats(d ?? null)
    })
    return () => {
      alive = false
    }
  }, [])
  return stats
}

export const fmtQuarter = (iso) => {
  if (!iso) return ''
  const [y, m] = iso.split('-')
  return `Q${Math.ceil(Number(m) / 3)} ${y}`
}

export const fmtCompactUsd = (v) => {
  if (v == null || Number.isNaN(v)) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${Math.round(v).toLocaleString()}`
}

export const fmtCount = (v) => (v == null ? '—' : Math.round(v).toLocaleString())

export const fmtPct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`)

// Delta display: sign, formatted magnitude, and which color token applies.
// `goodWhenDown` flips the coloring for metrics where a decline is the
// desirable direction (e.g. share of firms with disclosures).
export function deltaView(delta, { goodWhenDown = false } = {}) {
  if (delta == null) return null
  const pct = Math.abs(delta) * 100
  const magnitude = pct < 0.05 ? '0.0%' : `${pct.toFixed(1)}%`
  const up = delta > 0
  const flat = magnitude === '0.0%'
  const good = flat ? null : goodWhenDown !== up
  return {
    arrow: flat ? '–' : up ? '▲' : '▼',
    text: `${flat ? '' : up ? '+' : '−'}${magnitude}`,
    tone: flat ? 'flat' : good ? 'good' : 'bad',
  }
}

// One registry entry per metric: definition line shown on the KPI card and
// the fuller methodology footnote, so the copy can't drift between surfaces.
export const PULSE_META = {
  firms: {
    label: 'Active SEC-registered advisers',
    definition: 'Firms with an active registration and a Form ADV filing within the last 15 months.',
    methodology:
      'Reconstructed per quarter-end from the SEC’s monthly Form ADV filing archives: each firm’s latest filing on or before the quarter-end, no older than 15 months, excluding firms that had filed Form ADV-W (withdrawal) by that date.',
  },
  raum: {
    label: 'Aggregate regulatory AUM',
    definition:
      'Gross regulatory AUM summed across firms — double-counts fund complexes and sub-advised assets; treat as an index of scale, not real client wealth.',
    methodology:
      'Sum of Form ADV Item 5.F regulatory AUM over all firms in the quarter snapshot. Related advisers within one complex each file separately and sub-advised assets can appear at both the adviser and sub-adviser, so this gross total materially overstates distinct client assets. It is presented for trend comparison, in the same spirit as the SEC’s own aggregate statistics.',
  },
  median_aum: {
    label: 'Median firm AUM',
    definition: 'The middle firm by regulatory AUM.',
    methodology: 'Median of Form ADV Item 5.F regulatory AUM across the quarter snapshot.',
  },
  pct_disclosure: {
    label: 'Firms with a disclosure event',
    definition: 'Share of firms answering yes to any Form ADV Item 11 question.',
    methodology:
      'Item 11 covers criminal, regulatory, and civil-judicial events, including matters that were settled, dismissed, or involve affiliates. A disclosure is a reason to read the record, not a finding of wrongdoing.',
  },
  registrations: {
    label: 'Registrations & withdrawals',
    definition: 'Newly appearing registrants vs Form ADV-W withdrawal filings per quarter.',
    methodology:
      '“Appeared” counts CRDs present in a quarter snapshot but not the prior one (a proxy for new registrants); withdrawals count actual Form ADV-W filings in the quarter. The two measures come from different filings and need not sum to the net change.',
  },
  form_d: {
    label: 'Form D capital raised',
    definition: 'Coming in a future update — exempt-offering capital formation from SEC Form D filings.',
    methodology: '',
  },
}
