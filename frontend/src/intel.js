import { staffOf } from './benchmarking/factors.js'
import { againstFirm, KIND_LABELS } from './disclosures.js'
import { DEAL_FLAG_DEFS } from './dealFlags.js'
import { nonAdvisoryStaff } from './leverage.js'
import { describeRank, metricStats, PEER_METRIC_BY_ID } from './peers.js'
import { fmtCompactUsd, ordinal } from './pulse.js'
import { aumShare, firmSegment, isFamilyOfficeStyle, SEGMENT_BY_ID } from './segments.js'
import { ITEMS } from './sources.js'
import { fmtMultiple } from './trajectory.js'

// The analysis behind the Advisor Intelligence Report and the due-diligence
// questionnaire. Everything here is a deterministic reading of what the firm
// filed — no scores invented from thin air, no estimates presented as facts.
// Three distinctions are kept throughout, because they are where readers most
// often go wrong with this data:
//
//   1. A disclosed arrangement (performance fees, an affiliated broker-dealer)
//      is not misconduct. It is a conflict of interest the firm is required to
//      disclose, and a reason to ask how it is managed.
//   2. AUM growth is not investment performance. AUM rises with markets, new
//      clients and acquisitions; no Form ADV figure measures returns.
//   3. Missing is not negative. A figure a firm didn't report, or a data set
//      that doesn't cover the firm, says nothing either way, and is labelled
//      as missing rather than shown as zero or "no".
//
// ctx: { allFirms, cohort (peers.peerCohort), growth ({ entry, endYear }),
//        disclosures ({ events, coversFrom, asOf }), owners ({ owners }),
//        ownershipChanges ([{ date, events }]), dealFlags, holdings (13F view),
//        funds ([...]) } — any of them may be undefined (loading) or null
//        (not covered); every function copes with either.

const nameOf = (f) => f.business_name || f.legal_name
const pct = (v) => `${Math.round(v)}%`

// ---- conflicts of interest ---------------------------------------------------

/**
 * Disclosed arrangements that can create conflicts of interest:
 * [{ id, label, status: 'disclosed'|'not_reported'|'not_covered', detail, why, source }].
 * 'not_reported' means the firm's filing doesn't report it; 'not_covered'
 * means the data set that would show it doesn't cover this firm.
 */
export function conflictIndicators(firm, ctx = {}) {
  const out = []
  const yes = (v) => (v === true ? 'disclosed' : 'not_reported')
  out.push({
    id: 'performance_fees',
    label: 'Performance-based fees',
    status: yes(firm.fee_performance_based),
    detail: firm.fee_performance_based ? 'Reports charging fees based on a share of capital gains or appreciation.' : null,
    why: 'A share of gains can reward taking more risk, and can favor accounts that pay it over those that don’t.',
    source: ITEMS.fees,
  })
  out.push({
    id: 'commissions',
    label: 'Commissions',
    status: yes(firm.fee_commissions),
    detail: firm.fee_commissions ? 'Reports compensation by commission.' : null,
    why: 'Pay that depends on what is bought or sold can reward activity or particular products over the client’s interest.',
    source: ITEMS.fees,
  })
  out.push({
    id: 'broker_dealer',
    label: 'Broker-dealer ties',
    status: firm.broker_dealer ? 'disclosed' : 'not_reported',
    detail:
      firm.broker_dealer === 'registered'
        ? 'Also registered as a broker-dealer.'
        : firm.broker_dealer === 'affiliated'
          ? 'Affiliated with a broker-dealer.'
          : null,
    why: 'A firm or affiliate that earns brokerage compensation may have an incentive to route trades or recommend products through it.',
    source: firm.broker_dealer === 'registered' ? ITEMS.otherActivities : ITEMS.affiliations,
  })
  out.push({
    id: 'affiliations',
    label: 'Financial-industry affiliations',
    status: (firm.affil_count ?? 0) > 0 ? 'disclosed' : 'not_reported',
    detail: (firm.affil_count ?? 0) > 0 ? `${firm.affil_count} related ${firm.affil_count === 1 ? 'party' : 'parties'} reported.` : null,
    why: 'Affiliated banks, insurers, fund sponsors or other advisers can earn fees from the same client relationship.',
    source: ITEMS.affiliations,
  })
  const fundCount = Array.isArray(ctx.funds) ? ctx.funds.length : null
  out.push({
    id: 'private_funds',
    label: 'Advises private funds',
    status: ctx.funds === undefined ? 'loading' : fundCount ? 'disclosed' : 'not_reported',
    detail: fundCount ? `${fundCount} private fund${fundCount === 1 ? '' : 's'} on Schedule D.` : null,
    why: 'Recommending the firm’s own funds can add a second layer of fees and limit the comparison with outside options.',
    source: ITEMS.privateFunds,
  })
  for (const def of DEAL_FLAG_DEFS) {
    const flags = ctx.dealFlags
    out.push({
      id: `deal_${def.id}`,
      label: def.label,
      status: flags === undefined ? 'loading' : flags === null ? 'not_covered' : flags[def.id] ? 'disclosed' : 'not_reported',
      detail: flags?.[def.id] && flags.evidence?.[def.evidenceKey] ? `Brochure: “…${flags.evidence[def.evidenceKey]}…”` : null,
      why:
        def.id === 'pf'
          ? 'Placing clients in affiliated funds can earn the firm or its affiliates fees beyond the advisory fee.'
          : def.id === 'rs'
            ? 'Referral or revenue-sharing payments can reward recommending one provider over another.'
            : 'An affiliate serving as a fund’s general partner can be paid by the fund as well as by clients invested in it.',
      source: `${ITEMS.brochure} (keyword scan)`,
    })
  }
  return out
}

// ---- observations --------------------------------------------------------------

/**
 * Key observations for the executive summary: [{ id, tone, title, text, source }].
 * tone: 'context' for description, 'review' for something worth asking about.
 * Never 'good' or 'bad' — this data can't support a verdict.
 */
export function observations(firm, ctx = {}) {
  const out = []
  const segment = firmSegment(firm)
  const staff = staffOf(firm)
  const seg = segment ? SEGMENT_BY_ID[segment] : null

  // 1. What the firm is.
  const parts = [`${fmtCompactUsd(firm.aum_total)} in regulatory AUM`]
  if (firm.accounts_total != null) parts.push(`${firm.accounts_total.toLocaleString()} accounts`)
  if (staff != null) parts.push(`${staff.toLocaleString()} advisory professional${staff === 1 ? '' : 's'}`)
  out.push({
    id: 'profile',
    tone: 'context',
    title: seg ? seg.label : 'Business model not reported',
    text: `${nameOf(firm)} reports ${parts.join(', ')}.${seg ? ` ${seg.description}` : ' The filing does not break AUM out by client type, so its business model can’t be classified.'}`,
    source: `${ITEMS.aum}; ${ITEMS.clients}`,
  })

  // 2. Scale against peers.
  const cohort = ctx.cohort
  if (cohort) {
    const s = metricStats(PEER_METRIC_BY_ID.aum_per_pro, firm, cohort.peers)
    const r = describeRank(s.rank)
    if (r) {
      out.push({
        id: 'productivity',
        tone: 'context',
        title: 'Assets per professional',
        text: `${fmtCompactUsd(s.value)} of AUM per advisory professional, ${r.where} (${ordinal(r.pct)} percentile) among ${cohort.peers.length.toLocaleString()} ${cohort.label}; the peer median is ${fmtCompactUsd(s.median)}. High figures can mean institutional or model-based mandates as much as efficiency.`,
        source: `${ITEMS.aum}; ${ITEMS.staff}`,
      })
    }
  }

  // 3. High-net-worth specialization.
  const hnw = firm.pct_clients_hnw_individuals
  const wealth = aumShare(firm, 'wealth')
  if (isFamilyOfficeStyle(firm)) {
    out.push({
      id: 'hnw',
      tone: 'context',
      title: 'Family-office style',
      text:
        firm.aum_per_hnw_client != null
          ? `Averages ${fmtCompactUsd(firm.aum_per_hnw_client)} of AUM per high-net-worth client${hnw != null ? `, and ${pct(hnw)} of its clients are high-net-worth individuals` : ''}. Not a legal category: single-family offices are exempt from registration and never appear in this data.`
          : 'Calls itself a family office in its filed name. Not a legal category: single-family offices are exempt from registration and never appear in this data.',
      source: ITEMS.clients,
    })
  } else if (hnw != null && hnw >= 50) {
    out.push({
      id: 'hnw',
      tone: 'context',
      title: 'High-net-worth focus',
      text: `${pct(hnw)} of clients are high-net-worth individuals (roughly $1.1M or more under management or $2.2M net worth, by the SEC’s definition)${firm.aum_per_hnw_client != null ? `, averaging ${fmtCompactUsd(firm.aum_per_hnw_client)} each` : ''}.`,
      source: ITEMS.clients,
    })
  } else if (wealth != null && wealth < 25 && segment && segment !== 'wealth') {
    out.push({
      id: 'hnw',
      tone: 'review',
      title: 'Individual clients are a small part of the business',
      text: `Only ${pct(wealth)} of AUM comes from individuals and high-net-worth clients. Ask how private clients are served alongside the firm’s main ${seg.plural.replace(/s$/, '')} business.`,
      source: ITEMS.clients,
    })
  }

  // 4. Growth — explicitly not performance.
  const g = ctx.growth?.entry
  if (g?.a5 != null) {
    const rank = g.r5 != null ? `, faster than ${Math.max(1, Math.min(99, g.r5))}% of comparable firms` : ''
    out.push({
      id: 'growth',
      tone: g.a5 < 1 ? 'review' : 'context',
      title: g.a5 < 1 ? 'Assets have shrunk' : 'Asset growth',
      text: `Regulatory AUM is ${fmtMultiple(g.a5)} its level five years ago${rank}. This is growth in assets managed — from markets, new clients and acquisitions — not the investment return clients earned.`,
      source: ITEMS.history,
    })
  }
  if (g?.jump != null && ctx.growth?.endYear != null && g.jump > ctx.growth.endYear - 5) {
    out.push({
      id: 'jump',
      tone: 'review',
      title: `AUM at least doubled in ${g.jump}`,
      text: 'A one-year step that large usually reflects an acquisition, a merger, a new institutional mandate or a change in how AUM is reported, rather than organic growth.',
      source: ITEMS.history,
    })
  }

  // 5. Compensation and conflicts.
  const conflicts = conflictIndicators(firm, ctx).filter((c) => c.status === 'disclosed')
  out.push({
    id: 'conflicts',
    tone: conflicts.length ? 'review' : 'context',
    title: conflicts.length
      ? `${conflicts.length} disclosed arrangement${conflicts.length === 1 ? '' : 's'} with potential conflicts`
      : 'No conflict-related arrangements reported in the data reviewed',
    text: conflicts.length
      ? `${conflicts.map((c) => c.label).join('; ')}. These are disclosed business arrangements, not misconduct; the question is how each is managed and what it costs the client.`
      : 'None of the fee types, affiliations or brochure language this report checks were reported. The brochure and Form CRS describe conflicts in more detail than the structured data does.',
    source: `${ITEMS.fees}; ${ITEMS.affiliations}; ${ITEMS.brochure}`,
  })

  // 6. Regulatory record — counts, not conclusions.
  const n = firm.disciplinary_flag_count ?? 0
  const events = ctx.disclosures?.events
  const own = events ? events.filter(againstFirm).length : null
  out.push({
    id: 'record',
    tone: n > 0 ? 'review' : 'context',
    title: n > 0 ? `${n} Item 11 disclosure${n === 1 ? '' : 's'}` : 'No Item 11 disclosures reported',
    text:
      n > 0
        ? `Form ADV Item 11 covers the firm and every advisory affiliate, and includes settled, dismissed and pending matters.${events ? ` Of ${events.length} dated event${events.length === 1 ? '' : 's'} filed or updated since ${ctx.disclosures.coversFrom?.slice(0, 4) ?? 'the first archive'}, ${own} concern${own === 1 ? 's' : ''} the firm itself.` : ''} A disclosure is a reason to read the record, not a finding of wrongdoing.`
        : 'None of the criminal, regulatory or civil events Form ADV asks about were reported. That covers only those questions; it is not a review of everything that could matter.',
    source: ITEMS.disclosures,
  })

  // 7. Discretion.
  if (firm.aum_total > 0 && firm.aum_discretionary != null) {
    const share = firm.aum_discretionary / firm.aum_total
    if (share < 0.5) {
      out.push({
        id: 'discretion',
        tone: 'context',
        title: 'Mostly non-discretionary',
        text: `${pct(share * 100)} of AUM is discretionary. On the rest, the client approves each trade or the firm advises without trading authority — a different service from full discretionary management.`,
        source: ITEMS.aum,
      })
    }
  }

  // 8. Ownership changes.
  const changes = ctx.ownershipChanges
  if (Array.isArray(changes) && changes.length) {
    const latest = changes[0]
    out.push({
      id: 'ownership',
      tone: 'review',
      title: 'Ownership or leadership changes on file',
      text: `${changes.length} filing${changes.length === 1 ? '' : 's'} changed the firm’s owners or executive officers, most recently ${latest.date}. Ask what changed and whether it affects who serves clients or how they are paid.`,
      source: ITEMS.owners,
    })
  }

  return out
}

// ---- data limitations -----------------------------------------------------------

/** What this report could not see: [{ id, text }]. */
export function dataLimitations(firm, ctx = {}) {
  const out = []
  if (firm.aum_mix == null) out.push({ id: 'aum_mix', text: 'AUM by client type was not reported, so the business model and peer group are approximate.' })
  if (firm.accounts_total == null) out.push({ id: 'accounts', text: 'Number of accounts was not reported.' })
  if (staffOf(firm) == null) out.push({ id: 'staff', text: 'Advisory headcount was not reported, so per-professional figures are unavailable.' })
  if (ctx.growth === null) out.push({ id: 'growth', text: 'No multi-year AUM history: the firm is new, small, or wasn’t in the SEC’s annual reports.' })
  if (ctx.dealFlags === null) out.push({ id: 'deal', text: 'The firm’s brochure has not been keyword-scanned, so brochure-based conflict indicators are unknown, not absent.' })
  if (ctx.holdings === null) out.push({ id: '13f', text: 'No 13F filing covers this firm. Firms below $100M in US-listed equities don’t file one, so holdings are unknown, not absent.' })
  if (ctx.disclosures === null && (firm.disciplinary_flag_count ?? 0) > 0) {
    out.push({ id: 'events', text: 'No dated disclosure events were filed or updated in the period our archive covers; the full history is on IAPD.' })
  }
  out.push({ id: 'performance', text: 'Form ADV reports no investment performance. Nothing here measures the returns clients earned.' })
  out.push({ id: 'fees', text: 'Form ADV Part 1A reports fee types, not fee levels. Actual rates are in the firm’s brochure (Part 2A, Item 5) and its contract.' })
  out.push({ id: 'self', text: 'Every figure is self-reported by the firm on its regulatory filings, and can lag the firm’s current business by up to a year.' })
  return out
}

// ---- due-diligence questions -------------------------------------------------------

export const TOPICS = [
  { id: 'fees', label: 'Fees & total cost' },
  { id: 'conflicts', label: 'Conflicts of interest' },
  { id: 'record', label: 'Regulatory record' },
  { id: 'ownership', label: 'Ownership & stability' },
  { id: 'capacity', label: 'Growth, staffing & service capacity' },
  { id: 'investments', label: 'Investment approach & holdings' },
  { id: 'operations', label: 'Custody & operations' },
  { id: 'fit', label: 'Client fit' },
]

// Where a non-wealth firm's AUM mostly comes from, as the lead-in to a question.
const SEGMENT_SOURCE = {
  private_funds: 'Most of your AUM is in private funds.',
  institutional: 'Most of your AUM is managed for institutions.',
  registered_funds: 'Most of your AUM is in mutual funds, ETFs or BDCs.',
  mixed: 'No single client group accounts for most of your AUM.',
}

const q = (id, topic, question, why, evidence = [], specific = true) => ({ id, topic, question, why, evidence, specific })
const ev = (text, source) => ({ text, source })

/**
 * Firm-specific interview questions, each tied to the evidence that prompted
 * it: [{ id, topic, question, why, evidence: [{ text, source }], specific }].
 * `specific` false marks the baseline questions asked of every firm. Pure;
 * ids are stable so saved answers survive a data refresh.
 */
export function diligenceQuestions(firm, ctx = {}) {
  const out = []
  const staff = staffOf(firm)
  const segment = firmSegment(firm)
  const cohort = ctx.cohort

  // Fees — always, because Part 1A never says how much.
  out.push(
    q(
      'fee-schedule',
      'fees',
      'Please provide your complete fee schedule at my asset level, including breakpoints, minimums, and whether fees apply to cash, held-away or alternative assets.',
      'Form ADV Part 1A records which kinds of fees a firm charges, not the rates.',
      [ev(firmFeeTypes(firm), ITEMS.fees), ev('Rates and breakpoints are disclosed in the brochure.', ITEMS.feeSchedule)],
      false,
    ),
    q(
      'all-in-cost',
      'fees',
      'What will I pay in total each year, in dollars — advisory fee plus fund expenses, platform or wrap fees, trading costs and any fees charged by affiliates?',
      'The advisory fee is only one layer of cost; fund and platform expenses are often comparable in size.',
      [],
      false,
    ),
  )
  if (firm.fee_performance_based) {
    out.push(
      q(
        'performance-fees',
        'fees',
        'Which of your accounts or funds pay performance-based fees, how is the fee calculated (hurdle, high-water mark, crystallization), and how do you prevent favoring those accounts when allocating trades or opportunities?',
        'Performance fees can reward risk-taking and create an incentive to favor the accounts that pay them.',
        [ev('Reports performance-based fees.', ITEMS.fees)],
      ),
    )
  }
  if (firm.fee_commissions) {
    out.push(
      q(
        'commissions',
        'fees',
        'When are you or your representatives paid commissions, on which products, and will you put in writing which of my accounts are advisory and which are brokerage?',
        'Commission pay depends on what is sold; it changes the standard of care and the incentive behind a recommendation.',
        [ev('Reports compensation by commission.', ITEMS.fees)],
      ),
    )
  }

  // Conflicts.
  if (firm.broker_dealer) {
    out.push(
      q(
        'broker-dealer',
        'conflicts',
        firm.broker_dealer === 'registered'
          ? 'You are also a registered broker-dealer. In which capacity will you act for me, how will I know, and how are trading and execution costs on your own platform evaluated?'
          : 'Which broker-dealer are you affiliated with, will my trades or products go through it, and what does it or its representatives earn from my account?',
        'A broker-dealer relationship can earn compensation from the same client the adviser serves.',
        [ev(firm.broker_dealer === 'registered' ? 'Registered as a broker-dealer.' : 'Affiliated with a broker-dealer.', firm.broker_dealer === 'registered' ? ITEMS.otherActivities : ITEMS.affiliations)],
      ),
    )
  }
  if ((firm.affil_count ?? 0) > 0) {
    out.push(
      q(
        'affiliates',
        'conflicts',
        `You report ${firm.affil_count} financial-industry affiliation${firm.affil_count === 1 ? '' : 's'}. Which of them could earn fees from my account, and will you disclose those fees in dollars?`,
        'Affiliated banks, insurers, fund sponsors or advisers can be paid from the same relationship.',
        [ev(`${firm.affil_count} related ${firm.affil_count === 1 ? 'party' : 'parties'} on Schedule D.`, ITEMS.affiliations)],
      ),
    )
  }
  if (Array.isArray(ctx.funds) && ctx.funds.length) {
    const largest = [...ctx.funds].sort((a, b) => (b.gav ?? 0) - (a.gav ?? 0))[0]
    out.push(
      q(
        'own-funds',
        'conflicts',
        'Will you recommend any of your own private funds to me? If so, what fees does the fund pay you or your affiliates, on top of my advisory fee, and what are the lock-ups and redemption terms?',
        'Investing clients in the adviser’s own funds can layer fund-level fees on advisory fees and limit comparison with outside managers.',
        [ev(`${ctx.funds.length} private fund${ctx.funds.length === 1 ? '' : 's'} on file${largest?.name ? `, the largest ${largest.name} (${fmtCompactUsd(largest.gav)} gross assets)` : ''}.`, ITEMS.privateFunds)],
      ),
    )
  }
  if (ctx.dealFlags) {
    for (const def of DEAL_FLAG_DEFS) {
      if (!ctx.dealFlags[def.id]) continue
      const quote = ctx.dealFlags.evidence?.[def.evidenceKey]
      const evidence = [ev(quote ? `Brochure language: “…${quote}…”` : `Brochure language about ${def.description}.`, `${ITEMS.brochure} (keyword scan)`)]
      if (def.id === 'pf') {
        out.push(q('deal-pf', 'conflicts', 'Your brochure describes placing clients in affiliated or proprietary products. What share of client assets is in them today, and what does the firm earn from them beyond my advisory fee?', 'Proprietary products can pay the firm twice and narrow the choice of investments.', evidence))
      } else if (def.id === 'rs') {
        out.push(q('deal-rs', 'conflicts', 'Your brochure mentions referral or revenue-sharing arrangements. Who pays whom, how much, and would any of it apply to my account or the providers you recommend to me?', 'Payments for referrals or shelf space can reward recommending one provider over another.', evidence))
      } else {
        out.push(q('deal-gp', 'conflicts', 'Your brochure describes affiliates acting as general or limited partners of funds. If I invest in one, what does the affiliate receive (carry, management or other fees), and how are valuation and conflicts overseen?', 'A general partner is paid by the fund; when it is the adviser’s affiliate, that is a second source of pay from the same client.', evidence))
      }
    }
  }

  // Regulatory record.
  const n = firm.disciplinary_flag_count ?? 0
  const events = ctx.disclosures?.events ?? null
  if (n > 0) {
    const own = events ? events.filter(againstFirm) : []
    const recent = [...own].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 3)
    out.push(
      q(
        'disclosures',
        'record',
        own.length
          ? 'Please walk me through each disclosure event against the firm itself, what caused it, how it was resolved, and what you changed afterwards.'
          : `You report ${n} Item 11 disclosure${n === 1 ? '' : 's'}. Do they concern the firm itself or affiliates, and what was done about each?`,
        'Item 11 covers the firm and all its advisory affiliates and includes settled and dismissed matters. The explanation matters more than the count.',
        [
          ev(`${n} Item 11 disclosure${n === 1 ? '' : 's'} reported.`, ITEMS.disclosures),
          ...recent.map((e) =>
            ev(
              `${e.date ?? 'Undated'} · ${KIND_LABELS[e.kind] ?? 'Event'}${e.by ? ` by ${e.by}` : ''}${e.what ? ` · ${e.what}` : ''}${e.status ? ` (${e.status.toLowerCase()})` : ''}`,
              ITEMS.disclosures,
            ),
          ),
        ],
      ),
    )
  }
  out.push(
    q(
      'advisor-record',
      'record',
      'Who exactly will advise me, and may I have their individual CRD numbers so I can check their records on IAPD and BrokerCheck?',
      'Firm-level data does not show the record of the individual you will work with.',
      [ev('Individual records are on IAPD and FINRA BrokerCheck.', ITEMS.supplement)],
      false,
    ),
  )

  // Ownership & stability.
  const owners = ctx.owners?.owners ?? []
  const entityControl = owners.filter((o) => !o.is_individual && o.control)
  if (entityControl.length) {
    out.push(
      q(
        'outside-owners',
        'ownership',
        `${entityControl.slice(0, 2).map((o) => o.name).join(' and ')}${entityControl.length > 2 ? ' and others' : ''} hold control. What is their investment horizon, do they set revenue or growth targets, and would a sale change my fees or advisor?`,
        'Outside owners — private equity, consolidators or parent companies — can change priorities, pricing and staffing after a deal.',
        entityControl.slice(0, 3).map((o) => ev(`${o.name}${o.stake ? `, ${o.stake}` : ''} (control)`, ITEMS.owners)),
      ),
    )
  }
  const changes = Array.isArray(ctx.ownershipChanges) ? ctx.ownershipChanges : []
  if (changes.length) {
    const latest = changes[0]
    const names = latest.events.slice(0, 3).map((e) => `${e.type === 'added' ? 'Added' : e.type === 'removed' ? 'Removed' : 'Changed'}: ${e.name}`)
    out.push(
      q(
        'ownership-changes',
        'ownership',
        'Your filings show changes to owners or executive officers. What prompted them, and what is the succession plan for the firm’s leadership and for my advisor?',
        'Ownership and leadership changes often precede changes in service, pricing or investment approach.',
        [ev(`Most recent change filed ${latest.date}: ${names.join('; ')}.`, ITEMS.owners)],
      ),
    )
  }
  if (staff != null && staff <= 2) {
    out.push(
      q(
        'key-person',
        'ownership',
        `With ${staff} advisory professional${staff === 1 ? '' : 's'}, what happens to my account if my advisor is unavailable, leaves or dies? Is there a written continuity agreement?`,
        'Small firms concentrate client relationships in one or two people.',
        [ev(`${staff} advisory professional${staff === 1 ? '' : 's'} reported.`, ITEMS.staff)],
      ),
    )
  }

  // Growth & capacity.
  const g = ctx.growth?.entry
  if (g?.jump != null && ctx.growth?.endYear != null && g.jump > ctx.growth.endYear - 5) {
    out.push(
      q(
        'acquisition',
        'capacity',
        `Your AUM at least doubled in ${g.jump}. Was that an acquisition or merger, and how were the acquired clients, staff, systems and fee schedules integrated?`,
        'Integration can change service teams and pricing; it is also a common source of operational errors.',
        [ev(`One-year AUM step of 2× or more in ${g.jump}.`, ITEMS.history)],
      ),
    )
  }
  if (g?.a5 != null && g.a5 < 0.85) {
    out.push(
      q(
        'shrinking',
        'capacity',
        `Your regulatory AUM is ${fmtMultiple(g.a5)} its level five years ago. What drove the decline — client departures, market losses, a lost mandate — and how has it affected staffing?`,
        'Shrinking assets can strain a firm’s economics and staffing. It is not a measure of investment results.',
        [ev(`Five-year AUM multiple ${fmtMultiple(g.a5)}.`, ITEMS.history)],
      ),
    )
  } else if (g?.a5 != null && g.e5 != null && g.a5 >= 2 && g.e5 < g.a5 / 2) {
    out.push(
      q(
        'capacity-growth',
        'capacity',
        `Assets grew ${fmtMultiple(g.a5)} over five years while headcount grew ${fmtMultiple(g.e5)}. How have you kept service levels up, and what is your current client-to-advisor ratio?`,
        'Assets growing much faster than staff can stretch service capacity.',
        [ev(`Five-year AUM ${fmtMultiple(g.a5)}, employees ${fmtMultiple(g.e5)}.`, ITEMS.history)],
      ),
    )
  }
  if (cohort) {
    const s = metricStats(PEER_METRIC_BY_ID.accounts_per_pro, firm, cohort.peers)
    if (s.rank != null && s.rank >= 0.75 && s.value != null) {
      out.push(
        q(
          'workload',
          'capacity',
          `Each advisory professional averages about ${Math.round(s.value).toLocaleString()} accounts, more than three-quarters of ${cohort.label}. How many relationships will my lead advisor carry, and who covers when they are unavailable?`,
          'A high account load can mean less time per client, or a more standardized, model-based service.',
          [ev(`${Math.round(s.value).toLocaleString()} accounts per professional vs a peer median of ${Math.round(s.median).toLocaleString()}.`, `${ITEMS.accounts}; ${ITEMS.staff}`)],
        ),
      )
    }
  }
  const support = nonAdvisoryStaff(firm)
  if (support === 0 && staff != null && staff >= 3) {
    out.push(
      q(
        'no-support',
        'operations',
        'Every employee is reported as doing advisory work. Who handles compliance, operations, trading and client service, and are any of these outsourced?',
        'A firm with no separate operations staff relies on advisors or outside providers for those functions.',
        [ev('No non-advisory employees reported.', ITEMS.staff)],
      ),
    )
  }

  // Investments & holdings.
  const h = ctx.holdings
  if (h?.own && h.filer?.values_reliable && h.filer.top?.[0]?.pct >= 0.1) {
    const top = h.filer.top[0]
    out.push(
      q(
        'concentration',
        'investments',
        `Your most recent 13F shows ${top.issuer} at ${Math.round(top.pct * 100)}% of reported equity holdings. How do you manage concentration risk, and would my portfolio hold the same positions?`,
        'Concentrated firm-wide positions can signal a single strategy applied across clients.',
        [ev(`${top.issuer}: ${Math.round(top.pct * 100)}% of reported 13F value.`, ITEMS.holdings)],
      ),
    )
  }
  out.push(
    q(
      'investment-process',
      'investments',
      'How would my portfolio be built and monitored, who makes the decisions, and can you show audited or GIPS-compliant performance for the strategy you would use, net of all fees?',
      'Form ADV reports no investment performance; any track record has to come from the firm and should be verified.',
      [ev('No performance data in regulatory filings.', ITEMS.brochure)],
      false,
    ),
  )
  if (firm.aum_total > 0 && firm.aum_discretionary != null && firm.aum_discretionary / firm.aum_total < 0.5) {
    out.push(
      q(
        'discretion',
        'investments',
        `Only ${Math.round((firm.aum_discretionary / firm.aum_total) * 100)}% of your AUM is discretionary. Would you have trading authority over my account, and if not, how are recommendations implemented and how quickly?`,
        'Non-discretionary advice is a different service: the client approves trades, and execution can lag the recommendation.',
        [ev(`${fmtCompactUsd(firm.aum_discretionary)} of ${fmtCompactUsd(firm.aum_total)} is discretionary.`, ITEMS.aum)],
      ),
    )
  }

  // Custody & operations — not in the structured data, so always asked.
  out.push(
    q(
      'custody',
      'operations',
      'Which qualified custodian will hold my assets, will I receive statements directly from it, and does the firm or an affiliate ever have custody of client funds?',
      'Independent custody is the main safeguard against misappropriation; this data set does not show custody arrangements.',
      [ev('Custody is reported in Form ADV Item 9 and the brochure, which this site does not parse.', ITEMS.brochure)],
      false,
    ),
  )
  out.push(
    q(
      'cybersecurity',
      'operations',
      'How do you protect client data and verify instructions to move money, and have you had a cybersecurity incident affecting clients?',
      'Wire fraud and account takeover are among the most common losses for high-net-worth clients.',
      [],
      false,
    ),
  )

  // Client fit.
  const hnw = firm.pct_clients_hnw_individuals
  if (segment && segment !== 'wealth') {
    out.push(
      q(
        'core-business',
        'fit',
        `${SEGMENT_SOURCE[segment]} How central is private-client work to the firm, and who on the team is dedicated to it?`,
        'A firm whose main business is institutional or fund management may serve individuals as a sideline.',
        [ev(`Business model: ${SEGMENT_BY_ID[segment].label}.`, ITEMS.clients)],
      ),
    )
  }
  if (hnw != null) {
    out.push(
      q(
        'like-me',
        'fit',
        'How many of your clients look like me — similar assets, complexity and needs — and may I speak with one or two of them?',
        'Fit matters as much as credentials; the firm’s client mix shows who it is built to serve.',
        [ev(`${Math.round(hnw)}% of clients are high-net-worth individuals${firm.aum_per_hnw_client != null ? `, averaging ${fmtCompactUsd(firm.aum_per_hnw_client)}` : ''}.`, ITEMS.clients)],
        false,
      ),
    )
  }
  if (isFamilyOfficeStyle(firm)) {
    out.push(
      q(
        'family-office-scope',
        'fit',
        'Which family-office services are included in the fee — tax, estate, bill pay, insurance, philanthropy, family governance — and which are billed separately or provided by third parties?',
        'Family-office pricing varies widely in what it covers.',
        [ev('Family-office style firm.', ITEMS.clients)],
      ),
    )
  }
  if (firm.country && firm.country !== 'United States') {
    out.push(
      q(
        'jurisdiction',
        'fit',
        `You are headquartered in ${firm.country}. Which regulators oversee you, which law governs my agreement, and where would my assets be custodied?`,
        'A non-US firm can be SEC-registered while most of its operations are regulated elsewhere.',
        [ev(`Main office in ${firm.country}.`, 'Form ADV Part 1A, Item 1.F')],
      ),
    )
  }

  return out
}

/** "Percentage of AUM, performance-based" — or a clear statement that none were reported. */
export function firmFeeTypes(firm) {
  const types = []
  if (firm.fee_pct_of_aum) types.push('percentage of AUM')
  if (firm.fee_performance_based) types.push('performance-based')
  if (firm.fee_commissions) types.push('commissions')
  return types.length ? `Fee types reported: ${types.join(', ')}.` : 'No fee types reported in the structured filing data.'
}

/**
 * Status of every data set the report draws on, for the provenance table.
 * "None on file" and "not covered" are different answers and are kept apart.
 */
export function coverage(ctx) {
  const state = (v, none) => (v === undefined ? 'loading' : v === null ? none : 'included')
  return [
    { id: 'adv', label: 'Form ADV Part 1A (current filing)', status: 'included' },
    { id: 'history', label: 'Multi-year AUM and headcount history', status: state(ctx.growth, 'no history on file') },
    { id: 'disclosures', label: 'Dated disclosure events', status: state(ctx.disclosures, 'none filed in the period covered') },
    { id: 'owners', label: 'Owners and executive officers', status: state(ctx.owners, 'none on file') },
    { id: 'deal', label: 'Brochure keyword scan', status: state(ctx.dealFlags, 'brochure not scanned') },
    { id: 'funds', label: 'Private funds (Schedule D)', status: ctx.funds === undefined ? 'loading' : ctx.funds?.length ? 'included' : 'none reported' },
    { id: 'holdings', label: 'Form 13F equity holdings', status: state(ctx.holdings, 'not covered by any 13F') },
  ]
}
