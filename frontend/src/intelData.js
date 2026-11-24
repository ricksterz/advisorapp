import { useMemo } from 'react'

import { useDealFlags } from './dealFlags.js'
import { useFirmDisclosures } from './disclosures.js'
import { useFirmDocs } from './firmDocs.js'
import { useFirmHistory } from './firmHistory.js'
import { useFirmOwners, useOwnershipChanges } from './firmOwners.js'
import { useForm13f } from './form13f.js'
import { useFirmGrowth } from './growth.js'
import { peerCohort } from './peers.js'
import { useFirmPrivateFunds } from './privateFunds.js'
import { firmTrajectory, useTrajectoryData } from './trajectory.js'

// Everything the report and questionnaire read about one firm, gathered from
// the same per-firm shards its profile page loads. Each value keeps the
// shards' convention — undefined while loading, null when the data set
// doesn't cover the firm — so the analysis can tell "not yet" from "none".
export function useFirmIntel(firm, allFirms) {
  const crd = firm?.crd ?? 0
  const growth = useFirmGrowth(crd)
  const history = useFirmHistory(crd)
  const disclosures = useFirmDisclosures(crd)
  const owners = useFirmOwners(crd)
  const ownershipChanges = useOwnershipChanges(crd)
  const dealFlags = useDealFlags(crd)
  const holdings = useForm13f(crd)
  const funds = useFirmPrivateFunds(crd)
  const trajectoryData = useTrajectoryData(crd)
  const docs = useFirmDocs(crd)
  const cohort = useMemo(() => (firm ? peerCohort(firm, allFirms) : null), [firm, allFirms])
  const trajectory = trajectoryData === undefined ? undefined : firmTrajectory(trajectoryData, crd)

  const ctx = useMemo(
    () => ({ allFirms, cohort, growth, history, disclosures, owners, ownershipChanges, dealFlags, holdings, funds, trajectory, docs }),
    [allFirms, cohort, growth, history, disclosures, owners, ownershipChanges, dealFlags, holdings, funds, trajectory, docs],
  )
  const loading = [growth, disclosures, owners, ownershipChanges, dealFlags, holdings, funds].some((v) => v === undefined)
  return { ctx, loading }
}
