import { faviconUrl, useFavicons } from '../favicons.js'

// The one favicon every firm-name surface uses — table rows, ranking cards,
// the firm page's title and its website link — so a firm's icon is identical
// wherever it appears, and the placeholder check in favicons.js applies to all
// of them. onError still hides an icon that fails to decode at all.
export default function FirmFavicon({ host, size = 14, className }) {
  const favicons = useFavicons()
  const src = faviconUrl(favicons, host)
  if (!src) return null
  return (
    <img
      className={className}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      onError={(e) => {
        e.currentTarget.style.display = 'none'
      }}
    />
  )
}
