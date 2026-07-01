import { formatDate } from '../../utils/format';

const STAT = ({ value, label, color }) => (
  <div className="text-center px-4 py-3 rounded-xl bg-surface-50 border border-surface-100 min-w-[72px]">
    <p className={`text-2xl font-display font-bold ${color}`}>{value ?? '—'}</p>
    <p className="text-xs text-surface-500 mt-0.5">{label}</p>
  </div>
);

export default function AvailabilitySummary({ availability, train }) {
  if (!availability) return null;

  return (
    <div className="card mb-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div>
          <h2 className="font-display text-xl font-bold text-primary-700">
            {train?.trainName || availability.trainName}
          </h2>
          <p className="text-xs font-mono text-surface-400 mt-0.5">
            #{train?.trainNumber || availability.trainNumber}
          </p>
          {train?.from && (
            <div className="flex items-center gap-2 mt-2 text-sm text-surface-600">
              <span className="font-medium">{train.from.name}</span>
              <span className="text-surface-300">→</span>
              <span className="font-medium">{train.to?.name}</span>
            </div>
          )}
          {availability.departureDate && (
            <p className="text-xs text-surface-400 mt-1">
              Departure: <span className="text-surface-600 font-medium">{formatDate(availability.departureDate)}</span>
            </p>
          )}
        </div>

        <div className="flex gap-3 flex-wrap">
          <STAT value={availability.available} label="Available" color="text-emerald-600" />
          <STAT value={availability.locked}    label="Locked"    color="text-amber-600" />
          <STAT value={availability.booked}    label="Booked"    color="text-red-500" />
          <STAT value={availability.totalSeats} label="Total"   color="text-surface-700" />
        </div>
      </div>
    </div>
  );
}
