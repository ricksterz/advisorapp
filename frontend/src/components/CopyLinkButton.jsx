import { useEffect, useRef, useState } from 'react'

import { copyText } from '../clipboard.js'

const RESET_MS = 1600

/**
 * Copy a URL to the clipboard with inline "Copied ✓" feedback.
 *
 * When the copy genuinely fails — the clipboard API rejects without user
 * activation, and execCommand is no better — the URL is revealed in a
 * selectable field instead. Doing nothing visible would leave someone
 * clicking a dead button with no way to get the link; claiming "Copied ✓"
 * regardless would be worse still.
 */
export default function CopyLinkButton({
  url,
  label = 'Copy link',
  copiedLabel = 'Copied ✓',
  className = 'chip',
  title,
  onCopy,
}) {
  const [state, setState] = useState('idle') // idle | copied | failed
  const timer = useRef(null)
  const fallbackRef = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  // Reset if the button is reused for a different URL (e.g. SPA navigation
  // to another firm) so stale "Copied ✓" never carries over.
  useEffect(() => setState('idle'), [url])

  useEffect(() => {
    if (state === 'failed') fallbackRef.current?.select()
  }, [state])

  const handleClick = async () => {
    const ok = await copyText(url)
    onCopy?.(ok)
    clearTimeout(timer.current)
    if (!ok) {
      setState('failed')
      return
    }
    setState('copied')
    timer.current = setTimeout(() => setState('idle'), RESET_MS)
  }

  return (
    <span className="copy-link">
      <button type="button" className={className} onClick={handleClick} title={title ?? url}>
        {/* the label itself is the status, so announce changes politely
            rather than leaving a screen reader with no signal */}
        <span aria-live="polite">{state === 'copied' ? copiedLabel : label}</span>
      </button>
      {state === 'failed' && (
        <input
          ref={fallbackRef}
          className="copy-link-fallback"
          type="text"
          readOnly
          value={url}
          aria-label="Link to copy manually"
          onFocus={(e) => e.target.select()}
        />
      )}
    </span>
  )
}
