import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { fmtCompactUsd } from '../pulse.js'
import { firmPath, navigate } from '../router.js'
import { resultDetail, searchFirms } from '../search.js'

const goToFirm = (firm) => {
  window.history.pushState(null, '', firmPath(firm.crd))
  window.dispatchEvent(new PopStateEvent('popstate'))
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
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const input = useRef(null)
  const id = useId()

  const results = useMemo(
    () => (firms ? searchFirms(firms, query, 8 + exclude.length).filter((f) => !exclude.includes(f.crd)).slice(0, 8) : []),
    [firms, query, exclude],
  )

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

  const choose = (firm) => {
    setQuery('')
    setOpen(false)
    input.current?.blur()
    onSelect(firm)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((a) => Math.min(a + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter' && results.length) {
      e.preventDefault()
      choose(results[Math.min(active, results.length - 1)])
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
          aria-expanded={showList && results.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={showList && results.length ? `${id}-${active}` : undefined}
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
          {firms && results.length === 0 && (
            <li className="search-empty">
              {query.trim().length < 2 ? 'Keep typing…' : 'No registered firm matches. Try fewer words or a CRD.'}
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
                    choose(f)
                  }
                }}
              >
                <span className="search-name">{f.business_name || f.legal_name}</span>
                <span className="search-aum">{fmtCompactUsd(f.aum_total)}</span>
                <span className="search-detail">{resultDetail(f)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
