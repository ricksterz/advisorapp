/**
 * Copy text, with the fallback chain browsers actually require.
 *
 * navigator.clipboard is the modern path but rejects with NotAllowedError
 * whenever the document lacks focus or user activation — which happens in
 * plain-http contexts, some iframes, and automation. execCommand is
 * deprecated but is still the only thing that works in those cases, and it
 * too returns false without user activation.
 *
 * Both can fail, so this returns a boolean rather than throwing: the caller
 * needs to know whether to claim success, and a share button that says
 * "Copied ✓" when nothing was copied is worse than one that admits it.
 *
 * Dependencies are injected so the fallback order is unit-testable without a
 * DOM — this project's frontend tests are pure-logic and carry no jsdom.
 */
export async function copyText(text, deps = {}) {
  const {
    clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined,
    doc = typeof document !== 'undefined' ? document : undefined,
  } = deps

  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // fall through — an unfocused document rejects here routinely
    }
  }

  if (!doc?.createElement || !doc?.body) return false
  try {
    const ta = doc.createElement('textarea')
    ta.value = text
    // Off-screen rather than hidden: a display:none element cannot be
    // selected, so the copy would silently do nothing.
    ta.setAttribute('readonly', '')
    if (ta.style) {
      ta.style.position = 'fixed'
      ta.style.top = '-1000px'
      ta.style.opacity = '0'
    }
    doc.body.appendChild(ta)
    ta.select?.()
    const ok = doc.execCommand?.('copy') ?? false
    doc.body.removeChild(ta)
    return Boolean(ok)
  } catch {
    return false
  }
}
