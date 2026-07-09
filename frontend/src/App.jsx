import { useEffect, useState } from 'react'

const fmtAum = (v) =>
  v == null ? '—' : `$${(v / 1e9).toFixed(v >= 1e10 ? 0 : 1)}B`

export default function App() {
  const [firms, setFirms] = useState([])
  const [error, setError] = useState(null)
  const [minAum, setMinAum] = useState('')

  useEffect(() => {
    const params = new URLSearchParams({ limit: '50' })
    if (minAum) params.set('min_aum', String(Number(minAum) * 1e9))
    fetch(`/api/firms?${params}`)
      .then((r) => (r.ok ? r.json() : r.json().then((b) => Promise.reject(b.detail))))
      .then(setFirms)
      .catch((e) => setError(String(e)))
  }, [minAum])

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
