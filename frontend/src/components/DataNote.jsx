// Methodology and caveats, folded under "About this data" so a card's
// numbers come first, which matters most on a phone, where a long note can
// outrun the table above it. The text is unchanged and one tap away.
export default function DataNote({ children, summary = 'About this data' }) {
  return (
    <details className="data-note">
      <summary>{summary}</summary>
      <p className="detail-note">{children}</p>
    </details>
  )
}
