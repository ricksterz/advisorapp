import { useEffect, useState } from 'react'

import { loadShard } from './shards.js'

// Ownership & control from Form ADV Schedule A/B (etl/ownership.py) — direct
// owners and executive officers, plus the indirect owners above them, loaded
// from the firm's shard (see shards.js).
//
// Stake labels arrive pre-resolved from the ETL: the label depends on BOTH the
// schedule and the code (Schedule B's "F" is "Other", not a percentage, and
// Schedule A's NA/A/B don't exist on B), so resolving it here as well would be
// a second copy of that pairing waiting to drift.
//
// Falsy fields are omitted by the exporter to keep the file under Cloudflare's
// per-file limit, so treat a missing key as false/absent rather than unknown.

// Ownership change timeline (etl/ownership_changes.py) is a separate dataset,
// so a firm page that only needs the current roster never pays for history.

// Newest-first list of { date, filing_id, events[] }: undefined while
// loading, null if this firm has no detected changes. Most firms genuinely
// have none — only ~6.5K of ~17K filed a second time in the window.
export function useOwnershipChanges(crd) {
  const [timeline, setTimeline] = useState(undefined)
  useEffect(() => {
    let alive = true
    loadShard('ownership_changes', crd).then((data) => {
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
    loadShard('firm_owners', crd).then((data) => {
      if (alive) setEntry(data?.firms?.[String(crd)] ?? null)
    })
    return () => {
      alive = false
    }
  }, [crd])
  return entry
}
