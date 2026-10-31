import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { searchAdvisors } from '../advisors.js'
import { fmtCompactUsd } from '../pulse.js'
import { firmPath, navigate } from '../router.js'
import { resultDetail, searchFirms } from '../search.js'

const goToFirm = (firm) => {
  window.history.pushState(null, '', firmPath(firm.crd))
  window.dispatchEvent(new PopStateEvent('popstate'))
}

// An advisor opens on their (first) firm's page, scrolled to them in its roster.
export const advisorPath = (entry) => `${firmPath(entry[2][0])}?advisor=${entry[0]}`

const goTo = (path) => {
  window.history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

/** Advisor results for a query, debounced; { results, tooBroad, loading }. */
function useAdvisorResults(query, enabled) {
  const [state, setState] = useState({ results: [], tooBroad: false, loading: false })
  useEffect(() => {
    const q = query.trim()
    if (!enabled || q.length < 2 || /^\d+$/.test(q)) {
      setState({ results: [], tooBroad: false, loading: false })
      return undefined
    }
    let alive = true
    setState((s) => ({ ...s, loading: true }))
    const timer = setTimeout(() => {
      searchAdvisors(q, 6).then((r) => {
        if (alive) setState({ ...r, loading: false })
      })
    }, 150)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, enabled])
  return state
}

/**
 * Type-ahead firm search (an ARIA combobox). Arrow keys move through the
 * results, Enter opens the highlighted one (or the first), Escape closes.
 * `shortcut` makes "/" focus this box from anywhere on the page.
 */
export default function FirmSearch({
  firms,
  onSelect = goToFirm,
  exclude = [],
  placeholder = 'Search firms by name or CRD',
  className = '',
  shortcut = false,
  label = 'Search firms',
  advisors = false,
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const id = useId()

  const results = useMemo(
    () =>
      firms
        ? searchFirms(firms, query, 8 + exclude.length)
            .filter((f) => !exclude.includes(f.crd))
            .slice(0, advisors ? 5 : 8)
        : [],
    [firms, query, exclude, advisors],
  )
  const people = useAdvisorResults(query, advisors)
  const firmName = useMemo(() => {
    const byCrd = new Map((firms ?? []).map((f) => [f.crd, f.business_name || f.legal_name]))
    return (crd) => byCrd.get(crd)
  }, [firms])
  // One list for the keyboard: firms first, then advisors.
  const items = [
    ...results.map((f) => ({ kind: 'firm', key: `f${f.crd}`, path: firmPath(f.crd), firm: f })),
    ...people.results.map((e) => ({ kind: 'advisor', key: `a${e[0]}`, path: advisorPath(e), entry: e })),
  ]

  useEffect(() => {
    if (!shortcut) return undefined
    const onKey = (e) => {
      const tag = document.activeElement?.tagName
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcut])

  const choose = (item) => {
    setQuery('')
    setOpen(false)
    input.current?.blur()
    if (item.kind === 'advisor') goTo(item.path)
    else onSelect(item.firm)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault()
      choose(items[Math.min(active, items.length - 1)])
    } else if (e.key === 'Escape') {
      setOpen(false)
      input.current?.blur()
    }
  }

  const showList = open && query.trim().length > 0
  return (
    <div className={`firm-search ${className}`}>
      <span className="search">
        <span className="glyph" aria-hidden="true">⌕</span>
        <input
          ref={input}
          type="search"
          role="combobox"
          aria-label={label}
          aria-expanded={showList && items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={showList && items.length ? `${id}-${active}` : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {shortcut && !query && <kbd className="search-kbd" aria-hidden="true">/</kbd>}
      </span>
      {showList && (
        <ul className="search-results" role="listbox" id={`${id}-list`}>
          {!firms && <li className="search-empty">Loading firms…</li>}
          {firms && query.trim().length < 2 && !/^\d+$/.test(query.trim()) && (
            <li className="search-empty">Keep typing…</li>
          )}
          {advisors && results.length > 0 && (
            <li className="search-group" role="presentation">
              Firms
            </li>
          )}
          {results.map((f, i) => (
            <li key={f.crd} role="option" id={`${id}-${i}`} aria-selected={i === active}>
              <a
                href={firmPath(f.crd)}
                className={i === active ? 'active' : ''}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  if (onSelect === goToFirm) {
                    navigate(e, firmPath(f.crd))
                    setQuery('')
                    setOpen(false)
                  } else {
                    e.preventDefault()
                    choose(items[i])
                  }
                }}
              >
                <span className="search-name">{f.business_name || f.legal_name}</span>
                <span className="search-aum">{fmtCompactUsd(f.aum_total)}</span>
                <span className="search-detail">{resultDetail(f)}</span>
              </a>
            </li>
          ))}
          {advisors && people.results.length > 0 && (
            <li className="search-group" role="presentation">
              Advisors
            </li>
          )}
          {people.results.map((e, j) => {
            const i = results.length + j
            const [crd, name, employers, city, state, designations, disclosure] = e
            const firm = firmName(employers[0])
            const more = employers.length > 1 ? ` +${employers.length - 1}` : ''
            return (
              <li key={crd} role="option" id={`${id}-${i}`} aria-selected={i === active}>
                <a
                  href={advisorPath(e)}
                  className={i === active ? 'active' : ''}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={(ev) => {
                    navigate(ev, advisorPath(e))
                    setQuery('')
                    setOpen(false)
                  }}
                >
                  <span className="search-name">
                    {name}
                    {designations && <span className="search-badge">{designations}</span>}
                    {disclosure ? <span className="search-badge warn">Disclosures</span> : null}
                  </span>
                  <span className="search-detail">
                    {[firm ? `${firm}${more}` : null, [city, state].filter(Boolean).join(', ')]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </a>
              </li>
            )
          })}
          {people.total > people.results.length && (
            <li className="search-empty">
              {people.results.length} of {people.total.toLocaleString()} advisors. Add a middle initial or
              more of the name to narrow it.
            </li>
          )}
          {people.results.length > 0 && (
            <li className="search-note" role="presentation">
              From public SEC records, which may be out of date. A disclosures badge is not a finding
              of wrongdoing.
            </li>
          )}
          {advisors && people.tooBroad && (
            <li className="search-empty">Type more of a name to search advisors.</li>
          )}
          {firms &&
            query.trim().length >= 2 &&
            items.length === 0 &&
            !people.loading &&
            !people.tooBroad && (
              <li className="search-empty">
                {advisors ? 'No firm or advisor matches.' : 'No registered firm matches.'} Try fewer words
                or a CRD.
              </li>
            )}
        </ul>
      )}
    </div>
  )
}
