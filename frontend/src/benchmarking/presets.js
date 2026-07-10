// Named methodology presets. Every number the engine reads lives in these
// config objects — nothing ranking-related is hardcoded anywhere else.

export const PRESETS = [
  {
    id: 'default',
    label: 'Default (current methodology)',
    description:
      'The published methodology: clean record and staffing floor required, scale weighted heaviest, percentiles over the full ≥$100M universe.',
    config: {
      weights: { scale: 0.4, productivity: 0.25, feeAlignment: 0.15, disciplinaryRecord: 0, hnwFocus: 0 },
      top: { minAum: 1e8, minStaff: 3, maxDisclosures: 0 },
      risk: {
        minAum: 1e8,
        threshold: 40,
        points: { disclosures: 15, commissionsPlusPerf: 15, denseAffiliations: 10, highClientLoad: 15 },
      },
      cohorts: { aumBand: false, clientMix: false, region: false },
    },
  },
  {
    id: 'boutique',
    label: 'Boutique / HNW-focused',
    description:
      'Lower AUM floor, heavy weight on individual/HNW client concentration, ranked within AUM-band × client-mix peer cohorts so boutiques compete against boutiques.',
    config: {
      weights: { scale: 0.1, productivity: 0.2, feeAlignment: 0.25, disciplinaryRecord: 0, hnwFocus: 0.45 },
      top: { minAum: 2.5e7, minStaff: 1, maxDisclosures: 0 },
      risk: {
        minAum: 2.5e7,
        threshold: 40,
        points: { disclosures: 15, commissionsPlusPerf: 15, denseAffiliations: 10, highClientLoad: 15 },
      },
      cohorts: { aumBand: true, clientMix: true, region: false },
    },
  },
  {
    id: 'institutional',
    label: 'Institutional scale',
    description:
      'High AUM floor ($1B+) and productivity weighted hardest. Admits up to two disclosures — common at institutional scale — and grades the disciplinary record instead of hard-screening it.',
    config: {
      weights: { scale: 0.25, productivity: 0.45, feeAlignment: 0.1, disciplinaryRecord: 0.2, hnwFocus: 0 },
      top: { minAum: 1e9, minStaff: 10, maxDisclosures: 2 },
      risk: {
        minAum: 1e9,
        threshold: 40,
        points: { disclosures: 15, commissionsPlusPerf: 15, denseAffiliations: 10, highClientLoad: 15 },
      },
      cohorts: { aumBand: true, clientMix: false, region: false },
    },
  },
  {
    id: 'cleanRecord',
    label: 'Clean-record only',
    description:
      'Zero tolerance: scale ignored entirely, standing driven by productivity and fee alignment, and the risk list trips on a single disclosure.',
    config: {
      weights: { scale: 0, productivity: 0.5, feeAlignment: 0.5, disciplinaryRecord: 0, hnwFocus: 0 },
      top: { minAum: 1e8, minStaff: 3, maxDisclosures: 0 },
      risk: {
        minAum: 1e8,
        threshold: 15,
        points: { disclosures: 15, commissionsPlusPerf: 15, denseAffiliations: 10, highClientLoad: 15 },
      },
      cohorts: { aumBand: false, clientMix: false, region: false },
    },
  },
]

export const PRESET_BY_ID = Object.fromEntries(PRESETS.map((p) => [p.id, p]))

export const cloneConfig = (config) => JSON.parse(JSON.stringify(config))

export const defaultConfig = () => cloneConfig(PRESET_BY_ID.default.config)

export function configsEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return a === b
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) if (!configsEqual(a[k], b[k])) return false
  return true
}

// The preset a config matches exactly, or null (→ "Custom").
export function matchingPresetId(config) {
  const match = PRESETS.find((p) => configsEqual(p.config, config))
  return match ? match.id : null
}
