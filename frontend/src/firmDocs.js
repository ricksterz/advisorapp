import { useEffect, useState } from 'react'

import { advPdfUrl, crsUrl, firmApiUrl } from './sources.js'

/**
 * Brochure and Form CRS links, fetched on demand when a detail view opens —
 * these have no bulk-data equivalent, so they are never in firms.json.
 * Anything that can't be confirmed to exist is simply not rendered.
 */
export function useFirmDocs(crd) {
  const [docs, setDocs] = useState({ loading: true, brochures: [], crs: null, advPdf: null })

  useEffect(() => {
    let alive = true
    setDocs({ loading: true, brochures: [], crs: null, advPdf: null })

    const meta = fetch(firmApiUrl(crd))
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const source = json?.hits?.hits?.[0]?._source
        const content = source?.iacontent ? JSON.parse(source.iacontent) : null
        return {
          brochures: (content?.brochures?.brochuredetails ?? []).map((b) => ({
            id: b.brochureVersionID,
            name: b.brochureName,
            date: b.dateSubmitted,
          })),
          hasPdf: content?.basicInformation?.hasPdf === 'Y',
        }
      })
      .catch(() => ({ brochures: [], hasPdf: false }))

    // Form CRS only exists for firms with retail investors; probe and read
    // just the status, aborting before the PDF body downloads.
    const crsController = new AbortController()
    const crs = fetch(crsUrl(crd), { signal: crsController.signal })
      .then((r) => {
        const ok = r.ok
        crsController.abort()
        return ok
      })
      .catch(() => false)

    Promise.all([meta, crs]).then(([m, hasCrs]) => {
      if (!alive) return
      setDocs({
        loading: false,
        brochures: m.brochures,
        crs: hasCrs ? crsUrl(crd) : null,
        advPdf: m.hasPdf ? advPdfUrl(crd) : null,
      })
    })

    return () => {
      alive = false
      crsController.abort()
    }
  }, [crd])

  return docs
}
