// Splits the per-firm data files into shards so a firm page downloads only
// the slice holding its own firm, not every firm's.
//
// Before this, opening one firm page fetched ~11.6 MB compressed (~83 MB of
// JSON to parse) across nine files keyed by CRD. Each file is now also
// written as SHARD_COUNT pieces under public/shards/<dataset>/<n>.json, where
// n = CRD % SHARD_COUNT, and a firm page loads one piece per dataset. Every
// piece carries the dataset's non-firm fields too (period, years, ...), so a
// shard is a drop-in replacement for the whole file for any one firm.
//
// The firm list needs only a little of two of them, so it gets small index
// files instead: deal-flag booleans without the evidence snippets, and a
// count of advisor bios per firm.
//
// Runs before `vite dev` and `vite build` (package.json pre-scripts), from
// the committed source files, so nothing generated here is committed and the
// Cloudflare and GitHub Pages builds need no extra step.
//
// SHARD_COUNT must match src/shards.js. 32 keeps the deploy well inside
// Cloudflare's 20,000-file limit (17K pre-rendered firm pages already) while
// keeping the largest shard to a few hundred KB.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHARD_COUNT = 32

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const OUT = join(PUBLIC, 'shards')

// Datasets keyed by CRD under `firms`. form_13f also has `filers`, which a
// firm entry points into; each shard keeps only the filers its firms use.
const DATASETS = [
  'firm_owners',
  'ownership_changes',
  'firm_private_funds',
  'firm_history',
  'firm_trajectory',
  'form_13f',
  'deal_flags',
  'advisor_bios',
]

export const shardOf = (crd) => Number(crd) % SHARD_COUNT

/** Split one dataset: [{...meta, firms}] per shard. Pure, for testing. */
export function splitDataset(name, data) {
  const { firms = {}, filers, ...meta } = data
  const shards = Array.from({ length: SHARD_COUNT }, () => ({ ...meta, firms: {} }))
  for (const [crd, entry] of Object.entries(firms)) {
    shards[shardOf(crd)].firms[crd] = entry
  }
  if (name === 'form_13f' && filers) {
    for (const shard of shards) {
      shard.filers = {}
      for (const entry of Object.values(shard.firms)) {
        if (filers[entry.cik]) shard.filers[entry.cik] = filers[entry.cik]
      }
    }
  }
  return shards
}

/** What the firm list reads: flag booleans, and bio counts. */
export function listIndexes(dealFlags, advisorBios) {
  const out = {}
  if (dealFlags) {
    const firms = {}
    for (const [crd, { evidence, ...flags }] of Object.entries(dealFlags.firms ?? {})) {
      firms[crd] = flags
    }
    out.deal_flags_index = { generated_at: dealFlags.generated_at, firms }
  }
  if (advisorBios) {
    const firms = {}
    for (const [crd, bios] of Object.entries(advisorBios.firms ?? {})) {
      if (bios?.length) firms[crd] = bios.length
    }
    out.advisor_bios_index = { generated_at: advisorBios.generated_at, firms }
  }
  return out
}

function readJson(name) {
  const path = join(PUBLIC, `${name}.json`)
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function main() {
  rmSync(OUT, { recursive: true, force: true })
  let files = 0
  for (const name of DATASETS) {
    const data = readJson(name)
    if (!data) {
      console.log(`shard-data: no ${name}.json, skipping`)
      continue
    }
    const dir = join(OUT, name)
    mkdirSync(dir, { recursive: true })
    splitDataset(name, data).forEach((shard, i) => {
      writeFileSync(join(dir, `${i}.json`), JSON.stringify(shard))
      files += 1
    })
  }
  for (const [name, payload] of Object.entries(listIndexes(readJson('deal_flags'), readJson('advisor_bios')))) {
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(payload))
    files += 1
  }
  console.log(`shard-data: wrote ${files} files to public/shards/`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
