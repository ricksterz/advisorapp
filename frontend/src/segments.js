import { useEffect, useState } from 'react'

import { isFamilyOffice } from './familyOffice.js'
import { BASE } from './router.js'

// Business-model segments, from where a firm says its AUM comes from: Form ADV
// Item 5.D column (3), grouped in etl/ingest_adv.py (client_aum_fields) and
// packed by etl/export_json.py as aum_mix: [wealth, registered funds, private
// funds, institutional], each 0-100. A firm belongs to the group holding more
// than half its AUM, or to "mixed".
//
// Why not one wealth-vs-institutional split: 80% of firms with little wealth
// AUM run private funds, so that split files a $50M venture adviser next to a
// pension manager and compares their staffing as if they were the same
// business. And "hybrid" already means broker-dealer ties to most readers, so
// that is a tag here, not a segment.
export const SEGMENTS = [
  {
    id: 'wealth',
    label: 'Wealth manager',
    plural: 'wealth managers',
    mix: 0,
    description: 'Most AUM is managed for individuals and high-net-worth clients.',
  },
  {
    id: 'private_funds',
    label: 'Private fund manager',
    plural: 'private fund managers',
    mix: 2,
    description:
      'Most AUM is in pooled vehicles: hedge, private equity, venture capital, real estate or credit funds.',
  },
  {
    id: 'institutional',
    label: 'Institutional manager',
    plural: 'institutional managers',
    mix: 3,
    description:
      'Most AUM is for pension plans, insurers, charities, governments, sovereign wealth funds, banks, corporations or other advisers.',
  },
  {
    id: 'registered_funds',
    label: 'Registered fund manager',
    plural: 'registered fund managers',
    mix: 1,
    description: 'Most AUM is in mutual funds, ETFs and business development companies.',
  },
  {
    id: 'mixed',
    label: 'Mixed client base',
    plural: 'firms with a mixed client base',
    mix: null,
    description: 'No single client group accounts for more than half of AUM.',
  },
]

export const SEGMENT_BY_ID = Object.fromEntries(SEGMENTS.map((s) => [s.id, s]))

/** Share of AUM (0-100) from one segment's client group, or null when not reported. */
export const aumShare = (firm, segmentId) => firm.aum_mix?.[SEGMENT_BY_ID[segmentId].mix] ?? null

export function firmSegment(firm) {
  let best = null
  let bestShare = -1
  let reported = false
  for (const s of SEGMENTS) {
    const v = s.mix == null ? null : (firm.aum_mix?.[s.mix] ?? null)
    if (v == null) continue
    reported = true
    if (v > bestShare) {
      bestShare = v
      best = s.id
    }
  }
  if (!reported) return null // no AUM broken out by client type in this filing
  return bestShare > 50 ? best : 'mixed'
}

// Average AUM per high-net-worth client at which a wealth manager looks like a
// family office: 186 firms clear it, among them multi-family offices such as
// CapRock, Canopy and Wellspring that don't say "family office" in their name.
// The SEC's high-net-worth bar is about $1.1M under management.
export const FAMILY_OFFICE_CLIENT_AUM = 25e6

export function isFamilyOfficeStyle(firm) {
  if (isFamilyOffice(firm)) return true
  return firmSegment(firm) === 'wealth' && (firm.aum_per_hnw_client ?? 0) >= FAMILY_OFFICE_CLIENT_AUM
}

// Items 6.A(1) and 7.A(1): registered as a broker-dealer itself, or affiliated with one.
export const hasBrokerDealerTies = (firm) => firm.broker_dealer != null

export const FUND_TYPE_LABELS = {
  hedge: 'Hedge funds',
  private_equity: 'Private equity',
  venture: 'Venture capital',
  real_estate: 'Real estate',
  securitized: 'Securitized credit',
  liquidity: 'Liquidity funds',
  other: 'Other private funds',
  mixed: 'Several fund types',
}

/** Tags shown beside a firm's segment: [{ id, label, title }]. */
export function firmTags(firm, fundTypes) {
  const tags = []
  const segment = firmSegment(firm)
  const fundType = segment === 'private_funds' ? fundTypes?.firms?.[String(firm.crd)] : null
  if (fundType && FUND_TYPE_LABELS[fundType]) {
    tags.push({
      id: 'fund_type',
      label: FUND_TYPE_LABELS[fundType],
      title: 'Holds over half of the gross assets across its private funds (Schedule D 7.B.1)',
    })
  }
  if (isFamilyOfficeStyle(firm)) {
    tags.push({
      id: 'family_office',
      label: 'Family-office style',
      title: isFamilyOffice(firm)
        ? 'Calls itself a family office in its filed name'
        : `Wealth manager averaging $${Math.round(firm.aum_per_hnw_client / 1e6)}M per high-net-worth client (Item 5.D)`,
    })
  }
  if (hasBrokerDealerTies(firm)) {
    tags.push({
      id: 'broker_dealer',
      label: 'Broker-dealer ties',
      title: firm.broker_dealer === 'registered'
        ? 'Also registered as a broker-dealer (Item 6.A)'
        : 'Affiliated with a broker-dealer (Item 7.A)',
    })
  }
  return tags
}

// Main private fund type per firm (etl/fund_types.py), a small file so the
// firm list can filter on it without loading every fund.
let fundTypesPromise = null
function fetchFundTypes() {
  fundTypesPromise ??= fetch(`${BASE}firm_fund_types.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return fundTypesPromise
}

// undefined while loading, null when unavailable.
export function useFundTypes() {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchFundTypes().then((d) => {
      if (alive) setData(d)
    })
    return () => {
      alive = false
    }
  }, [])
  return data
}
