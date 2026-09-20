import { useNavigate } from 'react-router-dom';
import { useBookingStore } from '../../store/booking.store';
import { formatCurrency } from '../../utils/format';
import { MAX_SEATS_PER_BOOKING } from '../../utils/constants';
import Button from '../ui/Button';

export default function SelectionSummary() {
  const selectedSeats = useBookingStore((s) => s.selectedSeats);
  const navigate = useNavigate();

  const count = selectedSeats.size;
  let totalPrice = 0;
  selectedSeats.forEach((s) => (totalPrice += s.price || 0));

  if (count === 0) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30">
      {/* Blur gradient backdrop */}
      <div className="bg-white/80 backdrop-blur-md border-t border-surface-200 shadow-[0_-4px_24px_rgba(0,0,0,0.08)]">
        <div className="section-container py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary-100 text-primary-700 font-display font-bold text-lg">
              {count}
            </div>
            <div>
              <p className="text-sm font-medium text-surface-700">
                {count} seat{count !== 1 ? 's' : ''} selected
                <span className="text-surface-400 ml-1.5 font-normal">(max {MAX_SEATS_PER_BOOKING})</span>
              </p>
              <p className="font-display font-bold text-xl text-primary-700">{formatCurrency(totalPrice)}</p>
            </div>
          </div>
          <Button onClick={() => navigate('/booking')} className="shrink-0">
            Proceed to Booking →
          </Button>
        </div>
      </div>
    </div>
  );
}
