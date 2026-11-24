// Per-firm questionnaire state: an answer status and a note per question,
// a document checklist, and any questions the reader adds. Browser-only,
// keyed by CRD, and parsed defensively like the watchlist.

export const STATUSES = [
  { id: 'open', label: 'Not asked' },
  { id: 'asked', label: 'Asked, awaiting answer' },
  { id: 'satisfied', label: 'Answered satisfactorily' },
  { id: 'follow_up', label: 'Needs follow-up' },
]
const STATUS_IDS = new Set(STATUSES.map((s) => s.id))

export const DOCUMENTS = [
  { id: 'adv2a', label: 'Form ADV Part 2A brochure (current version)', why: 'Services, fee schedule, conflicts, disciplinary history in narrative form.' },
  { id: 'adv2b', label: 'Form ADV Part 2B supplement for each person who will advise you', why: 'Education, experience, outside business and disciplinary history of individuals.' },
  { id: 'crs', label: 'Form CRS relationship summary', why: 'Plain-language summary of fees, services, conflicts and standard of conduct.' },
  { id: 'agreement', label: 'Draft advisory agreement', why: 'Fees, termination terms, discretion, arbitration and liability clauses.' },
  { id: 'fees', label: 'Written fee quote at your asset level', why: 'The rate that will actually apply, including breakpoints and what assets are billed.' },
  { id: 'statement', label: 'Sample custodial statement and sample performance report', why: 'Shows who holds assets and how results and fees are reported.' },
  { id: 'gips', label: 'Performance composite or GIPS report for the proposed strategy', why: 'Form ADV contains no performance; verify any track record independently.' },
  { id: 'ethics', label: 'Code of ethics and personal-trading policy', why: 'How employee trading and gifts are controlled.' },
  { id: 'bcp', label: 'Business continuity and cybersecurity summaries', why: 'What happens in an outage, a breach, or if a key person leaves.' },
  { id: 'insurance', label: 'Errors & omissions and cyber insurance confirmation', why: 'Whether the firm is insured for professional errors and data incidents.' },
  { id: 'references', label: 'Client references with similar needs', why: 'Whether clients like you are well served.' },
]

export const MAX_NOTE = 4000
const key = (crd) => `od.diligence.v1.${crd}`

export function emptyState() {
  return { answers: {}, docs: {}, custom: [] }
}

export function parseDiligence(raw) {
  let data
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  const out = emptyState()
  if (!data || typeof data !== 'object') return out
  if (data.answers && typeof data.answers === 'object') {
    for (const [id, a] of Object.entries(data.answers)) {
      if (!/^[\w-]{1,64}$/.test(id) || !a || typeof a !== 'object') continue
      out.answers[id] = {
        status: STATUS_IDS.has(a.status) ? a.status : 'open',
        note: typeof a.note === 'string' ? a.note.slice(0, MAX_NOTE) : '',
      }
    }
  }
  if (data.docs && typeof data.docs === 'object') {
    for (const d of DOCUMENTS) if (data.docs[d.id] === true) out.docs[d.id] = true
  }
  if (Array.isArray(data.custom)) {
    out.custom = data.custom
      .filter((c) => c && typeof c.question === 'string' && /^c\d{1,15}$/.test(c.id))
      .slice(0, 50)
      .map((c) => ({ id: c.id, question: c.question.slice(0, 500) }))
  }
  return out
}

export function loadDiligence(crd) {
  try {
    return parseDiligence(window.localStorage.getItem(key(crd)))
  } catch {
    return emptyState()
  }
}

const isEmpty = (s) => !Object.keys(s.answers).length && !Object.values(s.docs).some(Boolean) && !s.custom.length

export function saveDiligence(crd, state) {
  try {
    // Opening a questionnaire shouldn't leave an empty record behind.
    if (isEmpty(state)) window.localStorage.removeItem(key(crd))
    else window.localStorage.setItem(key(crd), JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

/** { answered, followUp, total } for the progress line. */
export function progress(questions, state) {
  let answered = 0
  let followUp = 0
  for (const q of questions) {
    const s = state.answers[q.id]?.status
    if (s === 'satisfied') answered += 1
    if (s === 'follow_up') followUp += 1
  }
  return { answered, followUp, total: questions.length }
}
