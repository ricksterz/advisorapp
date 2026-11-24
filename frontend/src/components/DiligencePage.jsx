import { useEffect, useMemo, useState } from 'react'

import { downloadCsv } from '../csv.js'
import { DOCUMENTS, loadDiligence, MAX_NOTE, progress, saveDiligence, STATUSES } from '../diligence.js'
import { diligenceQuestions, TOPICS } from '../intel.js'
import { useFirmIntel } from '../intelData.js'
import { firmPath, navigate, reportPath } from '../router.js'
import { firmSources } from '../sources.js'
import CopyLinkButton from './CopyLinkButton.jsx'
import { useReportMeta } from './IntelligenceReport.jsx'
import WatchButton from './WatchButton.jsx'

const SITE_URL = 'https://open-disclosure.com'
const nameOf = (f) => f.business_name || f.legal_name

export default function DiligencePage({ firm, crd, allFirms, snapshot }) {
  const { ctx, loading } = useFirmIntel(firm, allFirms)
  const [state, setState] = useState(() => loadDiligence(crd))
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(true)
  useReportMeta(firm, 'Due-diligence questionnaire')

  // Rendered with key={crd}, so a different firm gets a fresh component and
  // its own stored state: saving here can never write one firm's answers
  // under another's key.
  useEffect(() => {
    setSaved(saveDiligence(crd, state))
  }, [crd, state])

  const generated = useMemo(() => (firm ? diligenceQuestions(firm, ctx) : []), [firm, ctx])
  const custom = state.custom.map((c) => ({ id: c.id, topic: 'custom', question: c.question, why: null, evidence: [], specific: false, custom: true }))
  const all = [...generated, ...custom]
  const prog = progress(all, state)

  if (!firm) return <div className="state">No firm with CRD {crd} in this snapshot.</div>

  const setAnswer = (id, patch) =>
    setState((s) => ({ ...s, answers: { ...s.answers, [id]: { status: 'open', note: '', ...s.answers[id], ...patch } } }))
  const toggleDoc = (id) => setState((s) => ({ ...s, docs: { ...s.docs, [id]: !s.docs[id] } }))
  const addCustom = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setState((s) => ({ ...s, custom: [...s.custom, { id: `c${Date.now()}`, question: text.slice(0, 500) }].slice(0, 50) }))
    setDraft('')
  }
  const removeCustom = (id) =>
    setState((s) => {
      const answers = { ...s.answers }
      delete answers[id]
      return { ...s, answers, custom: s.custom.filter((c) => c.id !== id) }
    })
  const clearAll = () => {
    if (window.confirm(`Clear every status, note and added question for ${nameOf(firm)}? This can’t be undone.`)) {
      setState({ answers: {}, docs: {}, custom: [] })
    }
  }
  const exportCsv = () => {
    const statusLabel = Object.fromEntries(STATUSES.map((s) => [s.id, s.label]))
    const topicLabel = Object.fromEntries(TOPICS.map((t) => [t.id, t.label]))
    const rows = [['Firm', 'CRD', 'Topic', 'Question', 'Firm-specific', 'Evidence', 'Status', 'Notes']]
    for (const q of all) {
      const a = state.answers[q.id]
      rows.push([
        nameOf(firm),
        firm.crd,
        q.custom ? 'Added by you' : topicLabel[q.topic],
        q.question,
        q.specific,
        q.evidence.map((e) => `${e.text} (${e.source})`).join(' | '),
        statusLabel[a?.status ?? 'open'],
        a?.note ?? '',
      ])
    }
    for (const d of DOCUMENTS) rows.push([nameOf(firm), firm.crd, 'Documents', d.label, false, d.why, state.docs[d.id] ? 'Received' : 'Not received', ''])
    downloadCsv(rows, `${nameOf(firm)} due diligence`)
  }

  const groups = [...TOPICS, { id: 'custom', label: 'Your questions' }]

  return (
    <article className="report diligence" aria-label={`Due-diligence questionnaire: ${nameOf(firm)}`}>
      <div className="report-toolbar no-print">
        <a className="back-link" href={firmPath(firm.crd)} onClick={(e) => navigate(e, firmPath(firm.crd))}>
          ← {nameOf(firm)} profile
        </a>
        <span className="spacer" />
        <button type="button" className="chip share-link" onClick={() => window.print()}>
          Print / save PDF
        </button>
        <button type="button" className="chip share-link" onClick={exportCsv}>
          Export CSV
        </button>
        <CopyLinkButton url={`${SITE_URL}/firm/${firm.crd}?view=diligence`} label="Copy link" className="chip share-link" />
        <WatchButton firm={firm} snapshotDate={snapshot} />
        <a className="chip share-link" href={reportPath(firm.crd)} onClick={(e) => navigate(e, reportPath(firm.crd))}>
          Intelligence report
        </a>
      </div>

      <header className="report-head">
        <p className="report-kicker">Due-diligence questionnaire</p>
        <h1>{nameOf(firm)}</h1>
        <p className="report-meta">
          CRD {firm.crd} · built from SEC Form ADV data as of {snapshot ?? 'the current snapshot'}
        </p>
        <p className="report-lede">
          Questions for your interview with the firm, generated from what it has disclosed. Firm-specific questions cite the
          filing that prompted them. Statuses and notes are saved in this browser only — nothing is sent anywhere — so export
          or print a copy to keep it.
        </p>
        <p className="diligence-progress" aria-live="polite">
          <strong>{prog.answered}</strong> of {prog.total} answered satisfactorily
          {prog.followUp > 0 && <> · <strong>{prog.followUp}</strong> need follow-up</>}
          {' · '}
          {Object.values(state.docs).filter(Boolean).length} of {DOCUMENTS.length} documents received
          {!saved && <span className="save-warning"> · Not saved: this browser is blocking storage</span>}
        </p>
        {loading && <p className="detail-note no-print">Still loading disclosure, ownership and fund data; more questions may appear.</p>}
      </header>

      {groups.map((t) => {
        const qs = all.filter((x) => x.topic === t.id)
        if (!qs.length && t.id !== 'custom') return null
        return (
          <section key={t.id} className="report-section" aria-labelledby={`dq-${t.id}`}>
            <h2 id={`dq-${t.id}`}>{t.label}</h2>
            <ol className="dq-list">
              {qs.map((q, qi) => {
                const a = state.answers[q.id] ?? { status: 'open', note: '' }
                return (
                  <li key={q.id} className={`dq-item dq-${a.status}`}>
                    <p className="question-text">
                      {q.question}
                      {q.specific && <span className="question-tag">Firm-specific</span>}
                    </p>
                    {q.why && <p className="dq-why">{q.why}</p>}
                    {q.evidence.length > 0 && (
                      <ul className="evidence-list">
                        {q.evidence.map((e, i) => (
                          <li key={i}>
                            {e.text} <span className="evidence-source">— {e.source}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="dq-controls">
                      <label className="dq-status">
                        <span className="sr-only">Status of {t.label} question {qi + 1}</span>
                        <select value={a.status} onChange={(e) => setAnswer(q.id, { status: e.target.value })}>
                          {STATUSES.map((s) => (
                            <option key={s.id} value={s.id}>{s.label}</option>
                          ))}
                        </select>
                      </label>
                      <span className="print-only">Status: {STATUSES.find((x) => x.id === a.status)?.label}</span>
                      {q.custom && (
                        <button type="button" className="link-btn no-print" onClick={() => removeCustom(q.id)}>
                          Remove
                        </button>
                      )}
                    </div>
                    <label className="dq-note">
                      <span className="sr-only">Notes on {t.label} question {qi + 1}</span>
                      <textarea
                        rows={2}
                        maxLength={MAX_NOTE}
                        placeholder="Their answer, documents provided, follow-ups…"
                        value={a.note}
                        onChange={(e) => setAnswer(q.id, { note: e.target.value })}
                      />
                    </label>
                    {a.note && <p className="dq-note-print print-only">{a.note}</p>}
                  </li>
                )
              })}
            </ol>
            {t.id === 'custom' && (
              <form className="dq-add no-print" onSubmit={addCustom}>
                <label className="sr-only" htmlFor="dq-new">Add your own question</label>
                <input id="dq-new" value={draft} maxLength={500} onChange={(e) => setDraft(e.target.value)} placeholder="Add your own question" />
                <button type="submit" className="chip share-link" disabled={!draft.trim()}>
                  Add
                </button>
              </form>
            )}
          </section>
        )
      })}

      <section className="report-section" aria-labelledby="dq-docs">
        <h2 id="dq-docs">Documents to request</h2>
        <ul className="doc-checklist">
          {DOCUMENTS.map((d) => (
            <li key={d.id}>
              <label>
                <input type="checkbox" checked={!!state.docs[d.id]} onChange={() => toggleDoc(d.id)} />
                <span>
                  <strong>{d.label}</strong>
                  <span className="dq-why"> {d.why}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="report-section" aria-labelledby="dq-sources">
        <h2 id="dq-sources">Where to verify answers</h2>
        <ul className="source-list">
          {firmSources(firm.crd, ctx.docs).map((s) => (
            <li key={s.href}>
              <a href={s.href} target="_blank" rel="noreferrer">{s.label} ↗</a>
              {s.note && <span className="source-note"> — {s.note}</span>}
            </li>
          ))}
        </ul>
        <p className="pulse-disclaimer">
          A starting point for your own diligence, not legal or investment advice. The questions reflect only what the firm
          has filed with the SEC; good answers to all of them don’t make a firm suitable for you.
        </p>
        <p className="no-print">
          <button type="button" className="link-btn" onClick={clearAll}>
            Clear this questionnaire
          </button>
        </p>
      </section>
    </article>
  )
}
