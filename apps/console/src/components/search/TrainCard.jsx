import { useNavigate } from 'react-router-dom';
import { useBookingStore } from '../../store/booking.store';
import { useAuthStore } from '../../store/auth.store';
import { formatSeatType } from '../../utils/format';
import Button from '../ui/Button';

const SEAT_TYPE_COLORS = {
  SLEEPER:    { bg: 'bg-blue-50',    text: 'text-blue-700',    dot: 'bg-blue-400' },
  AC_3_TIER:  { bg: 'bg-violet-50',  text: 'text-violet-700',  dot: 'bg-violet-400' },
  AC_2_TIER:  { bg: 'bg-indigo-50',  text: 'text-indigo-700',  dot: 'bg-indigo-400' },
  AC_FIRST:   { bg: 'bg-amber-50',   text: 'text-amber-700',   dot: 'bg-amber-400' },
  GENERAL:    { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-400' },
};

export default function TrainCard({ train }) {
  const navigate = useNavigate();
  const setSelectedTrain = useBookingStore((s) => s.setSelectedTrain);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const schedule = train.schedule;
  const seatSummary = train.seatSummary || {};
  const totalSeats = seatSummary.total || 0;

  const handleCheckAvailability = () => {
    if (!isAuthenticated) {
      navigate(`/login?redirect=${encodeURIComponent(`/seats/${schedule.scheduleId}`)}`);
      return;
    }
    setSelectedTrain(train, schedule.scheduleId);
    navigate(`/seats/${schedule.scheduleId}`);
  };

  const isCancelled = schedule?.status === 'CANCELLED';

  return (
    <div className="card-hover group">
      {/* Train name + number */}
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <h3 className="font-display font-bold text-surface-900 text-lg group-hover:text-primary-700 transition-colors">
              {train.trainName}
            </h3>
            {isCancelled && (
              <span className="badge badge-cancelled text-xs">Cancelled</span>
            )}
          </div>
          <p className="text-xs text-surface-400 font-mono">#{train.trainNumber}</p>
        </div>
        {totalSeats > 0 && (
          <div className="text-right shrink-0">
            <p className="text-xs text-surface-400 mb-0.5">Total seats</p>
            <p className="font-bold text-surface-700">{totalSeats}</p>
          </div>
        )}
      </div>

      {/* Journey timeline */}
      <div className="flex items-center gap-3 mb-5">
        <div className="text-right">
          <p className="font-bold text-xl text-surface-900">{train.from?.departure || '—'}</p>
          <p className="text-xs text-surface-500 mt-0.5 max-w-[100px] truncate">{train.from?.name}</p>
        </div>

        <div className="flex-1 flex flex-col items-center gap-1 px-2">
          <div className="flex items-center w-full">
            <div className="w-2.5 h-2.5 rounded-full bg-primary-500 shrink-0 ring-2 ring-primary-100" />
            <div className="flex-1 h-px bg-gradient-to-r from-primary-300 via-primary-200 to-accent-300 mx-1" />
            {/* Train icon in middle */}
            <div className="shrink-0 w-8 h-8 rounded-full bg-primary-50 border border-primary-100 flex items-center justify-center text-primary-600">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="5" width="14" height="7" rx="2" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.2"/>
                <rect x="3" y="6.5" width="3" height="2.5" rx="0.75" fill="currentColor"/>
                <rect x="7" y="6.5" width="3" height="2.5" rx="0.75" fill="currentColor"/>
                <circle cx="4" cy="13" r="1.5" fill="currentColor"/>
                <circle cx="12" cy="13" r="1.5" fill="currentColor"/>
              </svg>
            </div>
            <div className="flex-1 h-px bg-gradient-to-r from-accent-300 via-primary-200 to-primary-300 mx-1" />
            <div className="w-2.5 h-2.5 rounded-full bg-accent-500 shrink-0 ring-2 ring-accent-100" />
          </div>
        </div>

        <div>
          <p className="font-bold text-xl text-surface-900">{train.to?.arrival || '—'}</p>
          <p className="text-xs text-surface-500 mt-0.5 max-w-[100px] truncate">{train.to?.name}</p>
        </div>
      </div>

      {/* Seat type chips + CTA */}
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(seatSummary)
            .filter(([k, v]) => k !== 'total' && v > 0)
            .map(([type, count]) => {
              const colors = SEAT_TYPE_COLORS[type] || { bg: 'bg-surface-50', text: 'text-surface-600', dot: 'bg-surface-400' };
              return (
                <span key={type} className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${colors.bg} ${colors.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${colors.dot}`} />
                  {formatSeatType(type)}: {count}
                </span>
              );
            })}
        </div>

        {schedule && !isCancelled ? (
          <Button
            onClick={handleCheckAvailability}
            variant="accent"
            className="text-sm shrink-0 group-hover:shadow-glow-accent"
          >
            Check Availability →
          </Button>
        ) : (
          !schedule && (
            <span className="text-xs text-surface-400 italic">No schedule available</span>
          )
        )}
      </div>
    </div>
  );
}
