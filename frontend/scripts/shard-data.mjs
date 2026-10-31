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
// Build inputs that are never served: advisors.json is 27 MB, over the
// 25 MiB a single Cloudflare static asset may be, and the site only ever
// loads the pieces this script cuts from it.
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
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
  'firm_growth',
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
    for (const [crd, entry] of Object.entries(dealFlags.firms ?? {})) {
      // Only the booleans: the evidence snippets are most of the file.
      firms[crd] = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'evidence'))
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

// Advisor name search (advisors.json, from etl/advisor_index.py). Each person
// is filed under their first and last name, so "john smith" and "smith" both
// find John Smith. Every (name, person) filing is sorted alphabetically and
// cut into buckets of SEARCH_BUCKET_SIZE; meta.json holds the first name in
// each bucket, so the app can tell which buckets a typed prefix falls in
// (src/advisors.js) and fetch only those. ~210 files of ~55 KB compressed.
export const SEARCH_BUCKET_SIZE = 4000

export const nameTokens = (name) =>
  (name || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean)

/** The tokens a person is filed under: first and last name. */
function filingTokens(name) {
  const tokens = nameTokens(name).filter((t) => t.length > 1)
  return [...new Set([tokens[0], tokens[tokens.length - 1]].filter(Boolean))]
}

/** { meta: { starts, people }, buckets: entries[][] } from advisors.json's people. Pure. */
export function advisorSearch(people, size = SEARCH_BUCKET_SIZE) {
  const filed = []
  for (const p of people) for (const t of filingTokens(p[1])) filed.push([t, p[1], p.slice(0, 7)])
  filed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1].localeCompare(b[1])))
  const buckets = []
  const starts = []
  for (let i = 0; i < filed.length; i += size) {
    const chunk = filed.slice(i, i + size)
    starts.push(chunk[0][0])
    buckets.push(chunk.map(([, , entry]) => entry))
  }
  return { meta: { starts, people: people.length }, buckets }
}

/** Per firm: [advisors, advisors with disclosures], for the outlier list. Pure. */
export function advisorCounts(people) {
  const firms = {}
  for (const p of people) {
    for (const firm of p[2]) {
      const c = (firms[firm] ??= [0, 0])
      c[0] += 1
      c[1] += p[6] ? 1 : 0
    }
  }
  return { firms }
}

/** Per-firm rosters in the shape splitDataset expects. Pure. */
export function advisorRosters(people) {
  const firms = {}
  for (const [crd, name, employers, city, state, designations, disclosure, firstYear] of people) {
    for (const firm of employers) {
      ;(firms[firm] ??= []).push([crd, name, city, state, designations, disclosure, firstYear])
    }
  }
  const last = (name) => name.split(' ').at(-1)
  for (const roster of Object.values(firms)) {
    roster.sort((a, b) => last(a[1]).localeCompare(last(b[1])) || a[1].localeCompare(b[1]))
  }
  return { firms }
}

// A roster this long (Edward Jones has ~20,000 people) gets a file of its
// own, so the firms sharing its shard don't download it.
export const OWN_FILE_ROSTER = 1000

/** Split rosters into the sharded ones and those big enough for their own file. Pure. */
export function separateBigRosters({ firms }) {
  const small = {}
  const big = {}
  for (const [crd, roster] of Object.entries(firms)) {
    if (roster.length > OWN_FILE_ROSTER) {
      big[crd] = roster
      small[crd] = { own_file: true, count: roster.length }
    } else small[crd] = roster
  }
  return { small: { firms: small }, big }
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
  const advisorsPath = join(DATA, 'advisors.json')
  const advisors = existsSync(advisorsPath) ? JSON.parse(readFileSync(advisorsPath, 'utf8')) : null
  if (advisors) {
    const { generated_at: generatedAt, source } = advisors
    const { small, big } = separateBigRosters(advisorRosters(advisors.people))
    const dir = join(OUT, 'firm_advisors')
    mkdirSync(join(dir, 'firm'), { recursive: true })
    splitDataset('firm_advisors', { generated_at: generatedAt, source, ...small }).forEach((shard, i) => {
      writeFileSync(join(dir, `${i}.json`), JSON.stringify(shard))
      files += 1
    })
    for (const [crd, roster] of Object.entries(big)) {
      writeFileSync(join(dir, 'firm', `${crd}.json`), JSON.stringify(roster))
      files += 1
    }
    writeFileSync(
      join(OUT, 'advisor_counts.json'),
      JSON.stringify({ generated_at: generatedAt, source, ...advisorCounts(advisors.people) }),
    )
    files += 1
    const { meta, buckets } = advisorSearch(advisors.people)
    const searchDir = join(OUT, 'advisor_search')
    mkdirSync(searchDir, { recursive: true })
    writeFileSync(join(searchDir, 'meta.json'), JSON.stringify({ generated_at: generatedAt, source, ...meta }))
    buckets.forEach((entries, i) => writeFileSync(join(searchDir, `${i}.json`), JSON.stringify(entries)))
    files += 1 + buckets.length
  } else {
    console.log('shard-data: no advisors.json, skipping advisor search and rosters')
  }
  for (const [name, payload] of Object.entries(listIndexes(readJson('deal_flags'), readJson('advisor_bios')))) {
    writeFileSync(join(OUT, `${name}.json`), JSON.stringify(payload))
    files += 1
  }
  console.log(`shard-data: wrote ${files} files to public/shards/`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
