import { useLayoutEffect, useState } from 'react'

/** An element's content width in px, kept current as it resizes. */
export function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return undefined
    // Measure now: ResizeObserver's first callback waits for the next frame,
    // which a backgrounded tab may not paint for a long time.
    setWidth(Math.floor(ref.current.getBoundingClientRect().width))
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])
  return width
}
