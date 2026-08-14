import { useEffect, useState } from 'react'

import { BASE } from './router.js'

// Ownership & control from Form ADV Schedule A/B (etl/ownership.py) — direct
// owners and executive officers, plus the indirect owners above them. Same
// fetch-once-and-share pattern as firm_private_funds.json / advisor_bios.json.
//
// Stake labels arrive pre-resolved from the ETL: the label depends on BOTH the
// schedule and the code (Schedule B's "F" is "Other", not a percentage, and
// Schedule A's NA/A/B don't exist on B), so resolving it here as well would be
// a second copy of that pairing waiting to drift.
//
// Falsy fields are omitted by the exporter to keep the file under Cloudflare's
// per-file limit, so treat a missing key as false/absent rather than unknown.
let ownersPromise = null
function fetchOwners() {
  ownersPromise ??= fetch(`${BASE}firm_owners.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return ownersPromise
}

// Ownership change timeline (etl/ownership_changes.py) — a separate, much
// smaller file than firm_owners.json, so a firm page that only needs the
// current roster never pays for the history.
let changesPromise = null
function fetchChanges() {
  changesPromise ??= fetch(`${BASE}ownership_changes.json`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return changesPromise
}

// Newest-first list of { date, filing_id, events[] }: undefined while
// loading, null if this firm has no detected changes. Most firms genuinely
// have none — only ~6.5K of ~17K filed a second time in the window.
export function useOwnershipChanges(crd) {
  const [timeline, setTimeline] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchChanges().then((data) => {
      if (alive) setTimeline(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return timeline
}

// A single firm's owners: undefined while loading, null once resolved if the
// firm has none on file (or the file is unavailable, e.g. the dev fixture).
export function useFirmOwners(crd) {
  const [entry, setEntry] = useState(undefined)
  useEffect(() => {
    let alive = true
    fetchOwners().then((data) => {
      if (alive) setEntry(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return entry
}
