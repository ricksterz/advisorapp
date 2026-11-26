import { useEffect, useMemo, useRef, useState } from 'react'

import { usePageMeta } from '../pageMeta.js'
import { downloadCsv } from '../csv.js'
import {
  ASSET_PRESETS,
  compareScenarios,
  decodeState,
  effectiveRate,
  encodeState,
  EXAMPLE_FLAT,
  MAX_YEARS,
  normalizeTiers,
  parseMoney,
  sanitizeState,
  scheduleFee,
} from '../fees.js'
import { fmtCompactUsd } from '../pulse.js'
import { firmPath, navigate } from '../router.js'
import { ITEMS, iapdUrl } from '../sources.js'
import CopyLinkButton from './CopyLinkButton.jsx'
import { track, useTrackView } from '../analytics.js'

const SITE_URL = 'https://open-disclosure.com'
const usd = (v) => `$${Math.round(v).toLocaleString()}`
const rate = (v) => `${v.toFixed(2)}%`

function initialState() {
  const params = new URLSearchParams(window.location.search)
  return decodeState(params.get('c')) ?? sanitizeState(null)
}

function MoneyInput({ value, onChange, label, id, allowEmpty = false, placeholder }) {
  const [text, setText] = useState(value == null ? '' : Math.round(value).toLocaleString())
  useEffect(() => {
    // Reflect outside changes (preset buttons) without fighting the user's typing.
    if (parseMoney(text) !== value) setText(value == null ? '' : Math.round(value).toLocaleString())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  const v = parseMoney(text)
  return (
    <input
      id={id}
      aria-label={label}
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      aria-invalid={text !== '' && v == null}
      onChange={(e) => {
        setText(e.target.value)
        const n = parseMoney(e.target.value)
        if (n != null) onChange(n)
        else if (allowEmpty && e.target.value.trim() === '') onChange(null)
      }}
    />
  )
}

function NumberInput({ value, onChange, label, step = 0.01, min, max, id, suffix }) {
  return (
    <span className="num-input">
      <input
        id={id}
        type="number"
        aria-label={label}
        value={Number.isFinite(value) ? value : ''}
        step={step}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {suffix && <span className="num-suffix" aria-hidden="true">{suffix}</span>}
    </span>
  )
}

function ScheduleEditor({ scenario, index, onChange, onRemove, canRemove }) {
  const s = scenario.schedule
  const tiers = s.tiers
  const setSchedule = (patch) => onChange({ ...scenario, schedule: { ...s, ...patch } })
  const setTier = (i, patch) => setSchedule({ tiers: tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
  const addTier = () => {
    const capped = tiers.filter((t) => t.upTo != null)
    const last = capped.length ? capped[capped.length - 1].upTo : 0
    const next = last ? last * 2 : 1e6
    const open = tiers[tiers.length - 1]
    setSchedule({ tiers: [...capped, { upTo: next, rate: open.rate }, open] })
  }
  const removeTier = (i) => setSchedule({ tiers: normalizeTiers(tiers.filter((_, j) => j !== i)) })

  return (
    <fieldset className={`fee-scenario series-border-${index + 1}`}>
      <legend>
        <span className={`scaling-swatch series-${index + 1}`} aria-hidden="true" />
        <input
          className="scenario-name"
          aria-label={`Name of scenario ${index + 1}`}
          value={scenario.label}
          maxLength={40}
          onChange={(e) => onChange({ ...scenario, label: e.target.value })}
        />
      </legend>
      <label className="fee-field">
        <span>How tiers apply</span>
        <select value={s.mode} onChange={(e) => setSchedule({ mode: e.target.value })}>
          <option value="tiered">Tiered: each rate applies to its band of assets</option>
          <option value="whole">Breakpoint: the whole balance pays its band’s rate</option>
        </select>
      </label>
      <table className="tier-table">
        <thead>
          <tr>
            <th scope="col">Assets</th>
            <th scope="col" className="num">Annual rate</th>
            <th scope="col"><span className="sr-only">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t, i) => {
            const prev = i === 0 ? 0 : tiers[i - 1].upTo
            return (
              <tr key={i}>
                <td>
                  {t.upTo == null ? (
                    <span className="tier-open">{i === 0 ? 'All assets' : `Above ${fmtCompactUsd(prev)}`}</span>
                  ) : (
                    <span className="tier-cap">
                      {i === 0 ? 'First' : `${fmtCompactUsd(prev)} to`}{' '}
                      <MoneyInput value={t.upTo} label={`Tier ${i + 1} upper limit`} onChange={(v) => setTier(i, { upTo: Math.max(0, v) })} />
                    </span>
                  )}
                </td>
                <td className="num">
                  <NumberInput value={t.rate} step={0.05} min={0} max={10} label={`Tier ${i + 1} annual rate`} suffix="%" onChange={(v) => setTier(i, { rate: v })} />
                </td>
                <td>
                  {t.upTo != null && (
                    <button type="button" className="compare-remove" aria-label={`Remove tier ${i + 1}`} onClick={() => removeTier(i)}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <button type="button" className="link-btn" onClick={addTier} disabled={tiers.length >= 12}>
        + Add a breakpoint
      </button>
      <div className="fee-grid">
        <label className="fee-field">
          <span>Fixed annual fee</span>
          <MoneyInput value={s.fixed} label="Fixed annual fee" onChange={(v) => setSchedule({ fixed: Math.max(0, v) })} />
        </label>
        <label className="fee-field">
          <span>Minimum annual fee</span>
          <MoneyInput value={s.minimum} label="Minimum annual fee" onChange={(v) => setSchedule({ minimum: Math.max(0, v) })} />
        </label>
        <label className="fee-field">
          <span>Fund expense ratios</span>
          <NumberInput value={scenario.fundExpense} step={0.01} min={0} max={10} label="Underlying fund expense ratio" suffix="%" onChange={(v) => onChange({ ...scenario, fundExpense: v })} />
        </label>
        <label className="fee-field">
          <span>Other costs (platform, wrap, trading)</span>
          <NumberInput value={scenario.otherCost} step={0.01} min={0} max={10} label="Other annual costs" suffix="%" onChange={(v) => onChange({ ...scenario, otherCost: v })} />
        </label>
      </div>
      {canRemove && (
        <button type="button" className="link-btn" onClick={onRemove}>
          Remove this scenario
        </button>
      )}
    </fieldset>
  )
}

function BalanceChart({ result, years }) {
  const W = 640
  const H = 220
  const pad = { l: 64, r: 12, t: 10, b: 26 }
  const series = [
    { label: 'No costs (reference)', cls: 'series-ref', values: [result.baseline.rows[0].start, ...result.baseline.rows.map((r) => r.end)] },
    ...result.scenarios.map((s, i) => ({ label: s.label, cls: `series-line-${i + 1}`, values: [s.rows[0].start, ...s.rows.map((r) => r.end)] })),
  ]
  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const x = (i) => pad.l + (i / years) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max)
  return (
    <figure className="fee-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Projected balance over ${years} years for each scenario and a no-cost reference`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="chart-tick">{fmtCompactUsd(t)}</text>
          </g>
        ))}
        {[0, Math.round(years / 2), years].map((yr) => (
          <text key={yr} x={x(yr)} y={H - 6} textAnchor={yr === 0 ? 'start' : yr === years ? 'end' : 'middle'} className="chart-tick">Year {yr}</text>
        ))}
        {series.map((s) => (
          <polyline key={s.label} className={s.cls} fill="none" strokeWidth="2" points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
        ))}
      </svg>
      <figcaption className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <span className={`legend-line ${s.cls}`} aria-hidden="true" /> {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  )
}

export default function FeeCalculator({ allFirms }) {
  const [state, setState] = useState(initialState)
  const [showYears, setShowYears] = useState(false)
  const firmCrd = Number(new URLSearchParams(window.location.search).get('firm')) || null
  const firm = firmCrd && allFirms ? allFirms.find((f) => f.crd === firmCrd) : null
  const { assumptions: a, scenarios } = state

  usePageMeta({
    title: 'Wealth management fee calculator · Open Disclosure',
    description:
      'Calculate what an advisory fee schedule costs from $1M to $100M+, compare tiered and breakpoint schedules, and see the long-term effect of advisory fees and fund expenses.',
    path: 'fees',
  })

  const encoded = useMemo(() => encodeState(state), [state])
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('c', encoded)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [encoded])

  const result = useMemo(() => compareScenarios(a, scenarios), [a, scenarios])

  // One event per visit, on the first change; amounts and rates are never
  // sent. A scenario restored from a shared link is counted separately.
  const [fromLink] = useState(() => new URLSearchParams(window.location.search).has('c'))
  useTrackView('open_shared_fee_scenario', {}, fromLink)
  const used = useRef(false)
  const initial = useRef(encoded)
  useEffect(() => {
    if (!used.current && encoded !== initial.current) {
      used.current = true
      track('use_fee_calculator', { firm_context: firmCrd ? 'firm' : 'none' })
    }
  }, [encoded, firmCrd])
  const setA = (patch) => setState((s) => ({ ...s, assumptions: { ...s.assumptions, ...patch } }))
  const setScenario = (i, next) => setState((s) => ({ ...s, scenarios: s.scenarios.map((x, j) => (j === i ? next : x)) }))
  const addScenario = () =>
    setState((s) => ({ ...s, scenarios: [...s.scenarios, { ...EXAMPLE_FLAT, label: `Schedule ${String.fromCharCode(65 + s.scenarios.length)}` }].slice(0, 3) }))
  const removeScenario = (i) => setState((s) => ({ ...s, scenarios: s.scenarios.filter((_, j) => j !== i) }))

  const [first, second] = result.scenarios
  const ladder = [...new Set([...ASSET_PRESETS, a.assets])].filter((v) => v > 0).sort((x, y) => x - y)

  const exportCsv = () => {
    const rows = [['Year', ...result.scenarios.flatMap((s) => [`${s.label} start`, `${s.label} advisory fee`, `${s.label} investment costs`, `${s.label} end`]), 'No-cost reference end']]
    for (let i = 0; i < a.years; i++) {
      rows.push([
        i + 1,
        ...result.scenarios.flatMap((s) => [Math.round(s.rows[i].start), Math.round(s.rows[i].advisoryFee), Math.round(s.rows[i].investmentCost), Math.round(s.rows[i].end)]),
        Math.round(result.baseline.rows[i].end),
      ])
    }
    rows.push([])
    rows.push(['Assumptions', `Starting assets ${a.assets}`, `Years ${a.years}`, `Gross return ${a.grossReturn}%`, `Annual flow ${a.flow}`])
    rows.push(['Note', 'Illustrative projection from user-entered assumptions; not a forecast and not any firm’s actual fees.'])
    downloadCsv(rows, 'Open Disclosure fee projection', 'fee_projection')
  }

  return (
    <section className="fees-page" aria-label="Wealth management fee calculator">
      <div className="page-head">
        <h1>Wealth management fee calculator</h1>
        <p className="page-tagline">
          What an advisory fee schedule costs at your asset level — from $1M to $100M and beyond — and what it and the
          investments’ own expenses do to a portfolio over time.
        </p>
      </div>

      <div className="fee-notice" role="note">
        <strong>Every number here is an input you control.</strong> The starting schedules are examples, not any firm’s fees and
        not industry averages. Form ADV Part 1A reports only which kinds of fees a firm charges; its actual rates are in its
        brochure ({ITEMS.feeSchedule}) and Form CRS. Enter those, or the rates in a proposal, to compare real offers.
      </div>

      {firm && (
        <div className="fee-firm detail-card">
          <h2>
            Fee types{' '}
            <a href={firmPath(firm.crd)} onClick={(e) => navigate(e, firmPath(firm.crd))}>
              {firm.business_name || firm.legal_name}
            </a>{' '}
            reports
          </h2>
          <p>
            {[firm.fee_pct_of_aum && 'Percentage of AUM', firm.fee_performance_based && 'Performance-based', firm.fee_commissions && 'Commissions']
              .filter(Boolean)
              .join(' · ') || 'No fee types reported in the structured data'}
            . Rates aren’t in this data:{' '}
            <a href={iapdUrl(firm.crd)} target="_blank" rel="noreferrer">find its brochure on IAPD ↗</a> and enter its schedule below.
          </p>
        </div>
      )}

      <div className="fee-layout">
        <div className="fee-inputs">
          <fieldset className="fee-assumptions">
            <legend>Your portfolio and assumptions</legend>
            <label className="fee-field">
              <span>Starting assets</span>
              <MoneyInput value={a.assets} label="Starting assets" onChange={(v) => setA({ assets: Math.max(0, v) })} />
            </label>
            <div className="preset-row" role="group" aria-label="Asset level presets">
              {ASSET_PRESETS.map((v) => (
                <button key={v} type="button" className="chip" aria-pressed={a.assets === v} onClick={() => setA({ assets: v })}>
                  {fmtCompactUsd(v)}
                </button>
              ))}
            </div>
            <div className="fee-grid">
              <label className="fee-field">
                <span>Years</span>
                <NumberInput value={a.years} step={1} min={1} max={MAX_YEARS} label="Years to project" onChange={(v) => setA({ years: Math.max(1, Math.min(MAX_YEARS, Math.round(v) || 1)) })} />
              </label>
              <label className="fee-field">
                <span>Gross annual return (assumption)</span>
                <NumberInput value={a.grossReturn} step={0.25} min={-50} max={50} label="Gross annual return before costs" suffix="%" onChange={(v) => setA({ grossReturn: v })} />
              </label>
              <label className="fee-field">
                <span>Annual addition (− for withdrawal)</span>
                <MoneyInput value={a.flow} label="Annual contribution or withdrawal" onChange={(v) => setA({ flow: v })} />
              </label>
            </div>
          </fieldset>

          {scenarios.map((s, i) => (
            <ScheduleEditor key={i} index={i} scenario={s} onChange={(next) => setScenario(i, next)} onRemove={() => removeScenario(i)} canRemove={scenarios.length > 1} />
          ))}
          {scenarios.length < 3 && (
            <button type="button" className="chip share-link" onClick={addScenario}>
              + Add a scenario
            </button>
          )}
        </div>

        <div className="fee-results" aria-live="polite">
          <div className="fee-cards">
            {result.scenarios.map((s, i) => (
              <div key={i} className={`fee-card series-border-${i + 1}`}>
                <h3>
                  <span className={`scaling-swatch series-${i + 1}`} aria-hidden="true" /> {s.label}
                </h3>
                <dl>
                  <div><dt>First-year advisory fee</dt><dd>{usd(s.firstYearFee)}</dd></div>
                  <div><dt>Effective advisory rate</dt><dd>{rate(s.firstYearRate)}</dd></div>
                  <div><dt>All-in annual cost</dt><dd>{rate(s.allInRate)}</dd></div>
                  <div><dt>Costs paid over {a.years} years</dt><dd>{usd(s.totals.all)}</dd></div>
                  <div><dt>Balance after {a.years} years</dt><dd>{usd(s.totals.endBalance)}</dd></div>
                  <div className="fee-impact"><dt>Long-term impact vs no costs</dt><dd>{usd(s.costVsBaseline)}</dd></div>
                </dl>
              </div>
            ))}
          </div>
          {first && second && (
            <p className="fee-diff">
              Over {a.years} years, <strong>{first.totals.endBalance >= second.totals.endBalance ? first.label : second.label}</strong> leaves{' '}
              <strong>{usd(Math.abs(first.totals.endBalance - second.totals.endBalance))}</strong> more in the portfolio than{' '}
              {first.totals.endBalance >= second.totals.endBalance ? second.label : first.label}, under these assumptions.
            </p>
          )}

          <BalanceChart result={result} years={a.years} />

          <h3 className="report-sub">Effective advisory rate by asset level</h3>
          <div className="table-scroll">
            <table className="pulse-table">
              <thead>
                <tr>
                  <th>Assets</th>
                  {scenarios.map((s, i) => (
                    <th key={i} className="num">{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ladder.map((v) => (
                  <tr key={v} className={v === a.assets ? 'row-current' : undefined}>
                    <td>{fmtCompactUsd(v)}{v === a.assets ? ' (yours)' : ''}</td>
                    {scenarios.map((s, i) => (
                      <td key={i} className="num">
                        {rate(effectiveRate(v, s.schedule))} · {fmtCompactUsd(scheduleFee(v, s.schedule))}/yr
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="fee-actions">
            <CopyLinkButton url={`${SITE_URL}/fees?c=${encoded}`} label="Copy link to this scenario" className="chip share-link" trackAs="fee_scenario" />
            <button type="button" className="chip share-link" onClick={exportCsv}>Export CSV</button>
            <button type="button" className="chip share-link" aria-expanded={showYears} onClick={() => setShowYears(!showYears)}>
              {showYears ? 'Hide' : 'Show'} year-by-year
            </button>
          </div>

          {showYears && (
            <div className="table-scroll">
              <table className="pulse-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    {result.scenarios.map((s, i) => (
                      <th key={i} className="num">{s.label}: fees · end balance</th>
                    ))}
                    <th className="num">No costs</th>
                  </tr>
                </thead>
                <tbody>
                  {result.baseline.rows.map((r, y) => (
                    <tr key={r.year}>
                      <td>{r.year}</td>
                      {result.scenarios.map((s, i) => (
                        <td key={i} className="num">
                          {fmtCompactUsd(s.rows[y].advisoryFee + s.rows[y].investmentCost)} · {fmtCompactUsd(s.rows[y].end)}
                        </td>
                      ))}
                      <td className="num">{fmtCompactUsd(r.end)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <details className="methodology">
            <summary>How this is calculated</summary>
            <div className="method-body">
              <p>
                Each year the advisory fee is charged on the balance at the start of the year: in tiered mode, each band of
                assets pays its own rate; in breakpoint mode, the whole balance pays the rate of the band it falls in. Fixed fees
                are added and the minimum applied. Fund expenses and other costs are a percentage of the same balance. The
                portfolio then earns the gross return you entered, and your annual addition or withdrawal is applied at year
                end.
              </p>
              <p>
                “Long-term impact” is the difference between the ending balance and the same portfolio with no costs at all, so
                it includes the growth the costs would otherwise have earned. Real billing is usually quarterly on a moving
                balance, and taxes, inflation and return variability are ignored, so treat the output as a comparison of
                schedules rather than a forecast.
              </p>
            </div>
          </details>
          <p className="pulse-disclaimer">
            Illustrative only. Projections depend entirely on your assumptions and are not a forecast, a quote, or investment
            advice. Confirm every fee in writing with the firm.
          </p>
        </div>
      </div>
    </section>
  )
}
