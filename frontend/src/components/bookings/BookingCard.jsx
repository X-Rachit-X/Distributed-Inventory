import { Link } from 'react-router-dom';
import Badge from '../ui/Badge';
import { formatDate, formatCurrency } from '../../utils/format';

const STATUS_BORDER = {
  CONFIRMED:       'border-l-emerald-400',
  PAYMENT_PENDING: 'border-l-amber-400',
  SEATS_HELD:      'border-l-amber-400',
  FAILED:          'border-l-red-500',
  CANCELLED:       'border-l-red-400',
  REFUND_PENDING:  'border-l-amber-400',
  REFUNDED:        'border-l-surface-300',
};

export default function BookingCard({ booking }) {
  const borderColor = STATUS_BORDER[booking.status] || 'border-l-surface-300';

  return (
    <Link
      to={`/bookings/${booking.id}`}
      className={`card-hover block border-l-4 ${borderColor} pl-5`}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 mb-1.5">
            <h3 className="font-display font-semibold text-surface-900 truncate">{booking.trainName}</h3>
            <Badge status={booking.status} />
          </div>
          <div className="flex items-center gap-2 text-sm text-surface-500">
            <span className="font-mono text-xs text-surface-400">#{booking.trainNumber}</span>
            <span className="text-surface-300">·</span>
            <span>{formatDate(booking.departureDate)}</span>
            <span className="text-surface-300">·</span>
            <span>{booking.seatCount} seat{booking.seatCount !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div className="text-right shrink-0">
          <p className="font-display font-bold text-xl text-primary-700">{formatCurrency(booking.totalAmount)}</p>
          <p className="text-xs text-surface-400 mt-0.5">{formatDate(booking.createdAt)}</p>
        </div>
      </div>
    </Link>
  );
}
