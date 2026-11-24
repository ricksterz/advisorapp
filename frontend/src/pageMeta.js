import { useEffect } from 'react'

const SITE_URL = 'https://open-disclosure.com'

// Title, description and canonical for a tool page, applied on client-side
// navigation. The served HTML already carries the same values
// (etl/gen_static_pages.py, TOOL_PAGES): keep the strings in sync.
export function usePageMeta({ title, description, path }) {
  useEffect(() => {
    const prevTitle = document.title
    document.title = title
    const meta = document.querySelector('meta[name="description"]')
    const canonical = document.querySelector('link[rel="canonical"]')
    const prevDesc = meta?.getAttribute('content')
    const prevCanonical = canonical?.getAttribute('href')
    if (description) meta?.setAttribute('content', description)
    if (path != null) canonical?.setAttribute('href', `${SITE_URL}/${path}`)
    return () => {
      document.title = prevTitle
      if (prevDesc != null) meta?.setAttribute('content', prevDesc)
      if (prevCanonical != null) canonical?.setAttribute('href', prevCanonical)
    }
  }, [title, description, path])
}
