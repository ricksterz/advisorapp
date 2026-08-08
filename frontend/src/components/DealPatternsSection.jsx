// Aggregate, editorial view of the deal-structuring flags (etl/brochures.py)
// banded by firm scale — computed live from firms.json + deal_flags.json by
// dealPatterns.js. Complements the per-firm card (FirmDetail.jsx) and the
// row-level filters/column (App.jsx) with a corpus-wide pattern.
export default function DealPatternsSection({ patterns }) {
  if (!patterns) return null // no usable overlap between firms.json and deal_flags.json

  return (
    <section className="deal-patterns" aria-label="Deal-structuring patterns by firm scale">
      <div className="section-head">
        <h2>Deal-structuring patterns by scale</h2>
        <p>
          How often each brochure-derived signal appears, banded by regulatory AUM and computed
          across every scanned firm. This is a keyword-scan-derived pattern across the corpus —
          context on how these signals track firm size, not evidence of wrongdoing at any
          individual firm. Firms never scanned (no brochure on file) are excluded from a band's
          rate rather than counted as clean.
        </p>
      </div>
      <div className="pattern-grid">
        {patterns.map((band) => (
          <div key={band.id} className="pattern-card">
            <div className="pattern-head">
              <h3>{band.label}</h3>
              <span className="pattern-n">{band.scanned.toLocaleString()} firms scanned</span>
            </div>
            <div className="pattern-bars">
              {band.flags.map((f) => (
                <div key={f.id} className="pattern-row" title={f.description}>
                  <span className="pattern-label">{f.label}</span>
                  <span className="pattern-meter">
                    <span className="track">
                      <span className="fill" style={{ width: `${f.pct}%` }} />
                    </span>
                    <span className="pattern-pct">{Math.round(f.pct)}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
