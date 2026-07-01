import { formatSeatType, formatCurrency } from '../../utils/format';

const STATUS_STYLES = {
  AVAILABLE: 'bg-emerald-50 border-emerald-300 hover:bg-emerald-100 hover:border-emerald-400 hover:shadow-md cursor-pointer hover:-translate-y-0.5',
  LOCKED:    'bg-amber-50 border-amber-300 cursor-not-allowed opacity-70',
  BOOKED:    'bg-red-50 border-red-200 cursor-not-allowed opacity-60',
  CANCELLED: 'bg-surface-100 border-surface-200 cursor-not-allowed opacity-40',
  SELECTED:  'bg-primary-600 border-primary-700 text-white cursor-pointer ring-2 ring-primary-300 shadow-glow scale-[1.03]',
};

const STATUS_TEXT = {
  AVAILABLE: 'text-emerald-700',
  LOCKED:    'text-amber-700',
  BOOKED:    'text-red-600',
  CANCELLED: 'text-surface-500',
  SELECTED:  'text-primary-100',
};

export default function SeatTile({ seat, isSelected, onToggle }) {
  const effectiveStatus = seat.segmentStatus
    ? (seat.segmentStatus === 'AVAILABLE' ? 'AVAILABLE' : 'BOOKED')
    : seat.status;
  const status = isSelected ? 'SELECTED' : effectiveStatus;
  const canSelect = effectiveStatus === 'AVAILABLE';

  return (
    <button
      onClick={() => canSelect && onToggle(seat)}
      disabled={!canSelect && !isSelected}
      className={`border-2 rounded-xl p-2.5 text-center transition-all duration-200 min-w-[72px] ${STATUS_STYLES[status]}`}
      title={`Seat #${seat.seatNumber} · ${formatSeatType(seat.seatType)} · ${formatCurrency(seat.price)}`}
    >
      <p className={`text-sm font-bold ${isSelected ? 'text-white' : 'text-surface-800'}`}>
        #{seat.seatNumber}
      </p>
      <p className={`text-[10px] mt-0.5 ${isSelected ? 'text-primary-200' : STATUS_TEXT[effectiveStatus]}`}>
        {formatSeatType(seat.seatType)}
      </p>
      <p className={`text-xs font-semibold mt-0.5 ${isSelected ? 'text-white' : 'text-surface-700'}`}>
        {formatCurrency(seat.price)}
      </p>
    </button>
  );
}
