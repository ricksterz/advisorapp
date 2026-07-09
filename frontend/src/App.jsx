import { useEffect, useMemo, useState } from 'react'

const fmtAum = (v) =>
  v == null ? '—' : `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`

export default function App() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [minAum, setMinAum] = useState('')

  useEffect(() => {
    // Static snapshot exported by `python -m etl.export_json`; the published
    // site has no backend, so all filtering happens client-side.
    fetch(`${import.meta.env.BASE_URL}firms.json`)
      .then((r) => (r.ok ? r.json() : Promise.reject(`failed to load firms.json (${r.status})`)))
      .then(setData)
      .catch((e) => setError(String(e)))
  }, [])

  const firms = useMemo(() => {
    if (!data) return []
    const min = minAum ? Number(minAum) * 1e9 : null
    return data.firms
      .filter((f) => min == null || (f.aum_total ?? 0) >= min)
      .slice(0, 100)
  }, [data, minAum])

  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 960, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Advisor Comp &amp; Structure Analytics</h1>
      <label>
        Min AUM ($B):{' '}
        <input
          type="number"
          value={minAum}
          onChange={(e) => setMinAum(e.target.value)}
          placeholder="any"
        />
      </label>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      {data && (
        <p style={{ color: '#666' }}>
          {firms.length} of {data.count} firms shown · data snapshot {data.generated_at}
        </p>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '1rem' }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #ccc' }}>
            <th>CRD</th>
            <th>Firm</th>
            <th>Total AUM</th>
            <th>Discretionary</th>
            <th>Advisory staff</th>
            <th>Disciplinary flags</th>
          </tr>
        </thead>
        <tbody>
          {firms.map((f) => (
            <tr key={f.crd} style={{ borderBottom: '1px solid #eee' }}>
              <td>{f.crd}</td>
              <td>{f.business_name || f.legal_name}</td>
              <td>{fmtAum(f.aum_total)}</td>
              <td>{fmtAum(f.aum_discretionary)}</td>
              <td>{f.employees_advisory ?? '—'}</td>
              <td>{f.disciplinary_flag_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
