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
