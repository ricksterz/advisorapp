import { useEffect, useRef, useState } from 'react'

import { FACTORS } from '../benchmarking/factors.js'
import { RISK_SIGNALS } from '../benchmarking/screens.js'
import { normalizedWeights } from '../benchmarking/engine.js'
import { DIMENSION_ORDER, MIN_COHORT_SIZE } from '../benchmarking/cohort.js'
import { PRESETS, PRESET_BY_ID, cloneConfig, matchingPresetId } from '../benchmarking/presets.js'
import { urlForConfig } from '../benchmarking/url.js'

const AUM_FLOOR_OPTIONS = [
  { label: 'Any AUM', value: 0 },
  { label: '≥ $25M', value: 2.5e7 },
  { label: '≥ $50M', value: 5e7 },
  { label: '≥ $100M', value: 1e8 },
  { label: '≥ $500M', value: 5e8 },
  { label: '≥ $1B', value: 1e9 },
  { label: '≥ $10B', value: 1e10 },
]

const compactUsd = (v) =>
  v >= 1e9 ? `$${v / 1e9}B` : v >= 1e6 ? `$${v / 1e6}M` : `$${v.toLocaleString()}`

function AumFloorSelect({ value, onChange, ariaLabel }) {
  const options = AUM_FLOOR_OPTIONS.some((o) => o.value === value)
    ? AUM_FLOOR_OPTIONS
    : [...AUM_FLOOR_OPTIONS, { label: `≥ ${compactUsd(value)}`, value }].sort((a, b) => a.value - b.value)
  return (
    <select value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={ariaLabel}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

function NumberField({ label, value, onChange, min = 0, max = 999, step = 1 }) {
  return (
    <label className="mp-field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)))
        }}
      />
    </label>
  )
}

/**
 * Every knob the ranking engine reads, bound to the active MethodologyConfig.
 * Touching any control detaches from the preset ("Custom"); the copy-link
 * button captures the exact view as a reproducible URL.
 */
export default function MethodologyPanel({ config, onChange }) {
  const presetId = matchingPresetId(config)
  const weights = normalizedWeights(config.weights)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const set = (path, value) => {
    const next = cloneConfig(config)
    const keys = path.split('.')
    let node = next
    for (const k of keys.slice(0, -1)) node = node[k]
    node[keys.at(-1)] = value
    onChange(next)
  }

  const copyLink = async () => {
    const url = urlForConfig(config)
    window.history.replaceState(null, '', url)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      // clipboard unavailable (e.g. insecure context) — URL is in the address bar
    }
  }

  return (
    <div className="method-panel">
      <div className="mp-toolbar">
        <select
          value={presetId ?? 'custom'}
          onChange={(e) => {
            const preset = PRESET_BY_ID[e.target.value]
            if (preset) onChange(cloneConfig(preset.config))
          }}
          aria-label="Methodology preset"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
          {!presetId && <option value="custom">Custom</option>}
        </select>
        {!presetId && <span className="mp-custom-badge">Custom</span>}
        <span className="spacer" />
        <button type="button" className="chip" onClick={copyLink}>
          {copied ? 'Copied ✓' : 'Copy link to this view'}
        </button>
      </div>

      <div className="mp-groups">
        <fieldset className="mp-group">
          <legend>Standing-score weights</legend>
          {FACTORS.map((f) => (
            <label key={f.id} className="mp-slider" title={f.description}>
              <span className="mp-slider-label">{f.label}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round((config.weights[f.id] ?? 0) * 100)}
                onChange={(e) => set(`weights.${f.id}`, Number(e.target.value) / 100)}
              />
              <span className="mp-slider-pct">
                {weights[f.id] ? `${Math.round(weights[f.id] * 100)}%` : '—'}
              </span>
            </label>
          ))}
          <p className="mp-hint">Weights are relative — shares shown are normalized to 100%.</p>
        </fieldset>

        <fieldset className="mp-group">
          <legend>Top-list eligibility</legend>
          <label className="mp-field">
            <span>Minimum AUM</span>
            <AumFloorSelect
              value={config.top.minAum}
              onChange={(v) => set('top.minAum', v)}
              ariaLabel="Top list minimum AUM"
            />
          </label>
          <NumberField
            label="Min advisory professionals"
            value={config.top.minStaff}
            onChange={(v) => set('top.minStaff', v)}
          />
          <NumberField
            label="Max disciplinary disclosures"
            value={config.top.maxDisclosures}
            onChange={(v) => set('top.maxDisclosures', v)}
          />
        </fieldset>

        <fieldset className="mp-group">
          <legend>Risk screens</legend>
          <label className="mp-field">
            <span>Minimum AUM</span>
            <AumFloorSelect
              value={config.risk.minAum}
              onChange={(v) => set('risk.minAum', v)}
              ariaLabel="Risk list minimum AUM"
            />
          </label>
          {RISK_SIGNALS.map((s) => (
            <NumberField
              key={s.id}
              label={s.label}
              value={config.risk.points[s.id]}
              onChange={(v) => set(`risk.points.${s.id}`, v)}
              max={500}
            />
          ))}
          <NumberField
            label="Listing threshold (points)"
            value={config.risk.threshold}
            onChange={(v) => set('risk.threshold', v)}
            max={1000}
          />
        </fieldset>

        <fieldset className="mp-group">
          <legend>Peer cohorts</legend>
          <div className="mp-cohorts">
            {DIMENSION_ORDER.map((d) => (
              <button
                key={d.id}
                type="button"
                className="chip"
                aria-pressed={config.cohorts[d.id]}
                onClick={() => set(`cohorts.${d.id}`, !config.cohorts[d.id])}
              >
                {d.label}
              </button>
            ))}
          </div>
          <p className="mp-hint">
            Percentiles rank each firm within its peer cohort. Dimensions combine; a cohort with
            fewer than {MIN_COHORT_SIZE} firms falls back to the next-broadest pool (noted on the
            affected entries). With cohorts on, scores compare firms <em>within</em> their cohort —
            a 99 in one cohort doesn’t outrank a 98 in another.
          </p>
        </fieldset>
      </div>
    </div>
  )
}
