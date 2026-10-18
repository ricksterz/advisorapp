import { BASE } from './router.js'

// Per-firm data is split into shards at build time (scripts/shard-data.mjs):
// shards/<dataset>/<CRD % SHARD_COUNT>.json holds that slice of the dataset's
// firms plus its non-firm fields, so a firm page fetches a few hundred KB
// instead of every firm's records. Must match SHARD_COUNT in that script.
export const SHARD_COUNT = 32

const cache = new Map()

export const shardPath = (dataset, crd) => `${BASE}shards/${dataset}/${Number(crd) % SHARD_COUNT}.json`

/** The shard holding this firm, fetched once and shared; null if unavailable. */
export function loadShard(dataset, crd) {
  const url = shardPath(dataset, crd)
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    )
  }
  return cache.get(url)
}

/** The firm-list indexes the build writes beside the shards. */
export function loadIndex(name) {
  const url = `${BASE}shards/${name}.json`
  if (!cache.has(url)) {
    cache.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    )
  }
  return cache.get(url)
}
