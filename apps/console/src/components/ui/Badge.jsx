const STATUS_MAP = {
  CONFIRMED:       { label: 'Confirmed',       cls: 'badge-confirmed', dot: 'bg-emerald-500' },
  PAYMENT_PENDING: { label: 'Payment Pending', cls: 'badge-pending',   dot: 'bg-amber-500' },
  SEATS_HELD:      { label: 'Seats Held',      cls: 'badge-pending',   dot: 'bg-amber-500' },
  FAILED:          { label: 'Failed',           cls: 'badge-cancelled', dot: 'bg-red-500' },
  CANCELLED:       { label: 'Cancelled',        cls: 'badge-cancelled', dot: 'bg-red-500' },
  REFUND_PENDING:  { label: 'Refund Pending',  cls: 'badge-pending',   dot: 'bg-amber-500' },
  REFUNDED:        { label: 'Refunded',         cls: 'badge-default',   dot: 'bg-surface-400' },
};

export default function Badge({ status }) {
  const cfg = STATUS_MAP[status] || { label: status, cls: 'badge-default', dot: 'bg-surface-400' };
  const isConfirmed = status === 'CONFIRMED';

  return (
    <span className={cfg.cls}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dot} ${isConfirmed ? 'animate-pulse' : ''}`} />
      {cfg.label}
    </span>
  );
}
