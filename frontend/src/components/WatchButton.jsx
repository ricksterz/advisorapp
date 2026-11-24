import { follow, isWatched, unfollow, useWatchlist } from '../watchlist.js'

/**
 * Follow / unfollow a firm. `compact` renders an icon-only star for dense
 * rows; the accessible name always says which firm and what will happen.
 */
export default function WatchButton({ firm, snapshotDate, compact = false, className = '' }) {
  const list = useWatchlist()
  if (!firm) return null
  const on = isWatched(list, firm.crd)
  const name = firm.business_name || firm.legal_name
  const toggle = () => (on ? unfollow(firm.crd) : follow(firm, snapshotDate))
  return (
    <button
      type="button"
      className={`${compact ? 'watch-star' : 'chip share-link watch-btn'}${on ? ' on' : ''} ${className}`.trim()}
      aria-pressed={on}
      // A toggle keeps one name; aria-pressed carries the state.
      aria-label={`Follow ${name}`}
      title={on ? `Remove ${name} from your watchlist` : `Follow ${name}: saved in this browser only`}
      onClick={toggle}
    >
      <span aria-hidden="true">{on ? '★' : '☆'}</span>
      {!compact && <span>{on ? ' Following' : ' Follow'}</span>}
    </button>
  )
}
