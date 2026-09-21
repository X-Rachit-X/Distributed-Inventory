import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, newIdempotencyKey, ApiError } from '../api';

/**
 * Seat selection.
 *
 * The journey selector is the interesting control. A seat is not simply "free"
 * or "taken" — it is free FOR A SPAN. Seat A1 can be sold from Delhi to Kanpur
 * and simultaneously available from Kanpur onward, so availability is recomputed
 * whenever the journey changes.
 *
 * The page also states, in the interface rather than only in documentation,
 * that what it shows can be stale. That honesty is the point: a 409 on booking
 * is then an expected outcome the user was warned about, not a surprise failure.
 */
export default function SeatMap() {
     const { eventId } = useParams();
     const navigate = useNavigate();
     const [params] = useSearchParams();
     const presetFrom = params.get('from');
     const presetTo = params.get('to');

     const [stops, setStops] = useState([]);
     const [from, setFrom] = useState(presetFrom != null ? Number(presetFrom) : 0);
     const [to, setTo] = useState(presetTo != null ? Number(presetTo) : 1);
     const [resources, setResources] = useState(null);
     const [asOf, setAsOf] = useState(null);
     const [selected, setSelected] = useState([]);
     const [booking, setBooking] = useState(false);
     const [error, setError] = useState(null);

     // The span axis for this event, so the selector shows station names rather
     // than the integer indices the engine works in.
     useEffect(() => {
          fetch(`/api/events/${eventId}/span-points`)
               .then((r) => r.json())
               .then((r) => {
                    const points = r.data ?? [];
                    setStops(points);
                    // Keep a journey chosen on the search page; otherwise
                    // default to the whole route.
                    if (presetTo == null && points.length >= 2) setTo(points.length - 1);
               })
               .catch(() => setStops([]));
     }, [eventId]);

     const load = useMemo(
          () => async () => {
               try {
                    const r = await api.resources(eventId, from, to);
                    if (to <= from) return;
                    setResources(r.data.resources);
                    setAsOf(r.as_of);
               } catch (e) {
                    setError(e.message);
               }
          },
          [eventId, from, to]
     );

     useEffect(() => {
          if (to > from) {
               setSelected([]);
               load();
          }
     }, [load, from, to]);

     const byGroup = useMemo(() => {
          const groups = new Map();
          for (const r of resources ?? []) {
               if (!groups.has(r.group)) groups.set(r.group, []);
               groups.get(r.group).push(r);
          }
          return [...groups.entries()];
     }, [resources]);

     const toggle = (seat) => {
          if (seat.status !== 'AVAILABLE') return;
          setSelected((cur) =>
               cur.find((s) => s.resourceId === seat.resourceId)
                    ? cur.filter((s) => s.resourceId !== seat.resourceId)
                    : [...cur, seat]
          );
     };

     async function book() {
          setBooking(true);
          setError(null);
          // One key for this ATTEMPT, reused across any retry of it, so a lost
          // response replays rather than booking twice.
          const key = newIdempotencyKey();
          try {
               const { data } = await api.reserve(
                    {
                         eventId,
                         items: selected.map((s) => ({
                              resourceId: s.resourceId,
                              spanFrom: from,
                              spanTo: to,
                              priceCents: s.priceCents,
                         })),
                    },
                    key
               );
               navigate(`/reservations/${data.reservationId}`);
          } catch (err) {
               if (err instanceof ApiError && err.isConflict) {
                    setError('Someone took one of those seats first. The map has been refreshed.');
                    load();
                    setSelected([]);
               } else if (err instanceof ApiError && err.isRateLimited) {
                    setError(`Too many attempts. Try again in ${err.retryAfterSeconds ?? 5}s.`);
               } else {
                    setError(err.message);
               }
          } finally {
               setBooking(false);
          }
     }

     const total = selected.reduce((sum, s) => sum + s.priceCents, 0);

     return (
          <div>
               <button onClick={() => navigate('/trains')} className="text-sm text-slate-400 hover:text-slate-200 mb-4">
                    ← Departures
               </button>

               {/* Journey selector — changes which spans are checked */}
               <div className="card p-4 mb-6 flex flex-wrap items-end gap-4">
                    <div>
                         <label htmlFor="from" className="label block mb-1.5">
                              From
                         </label>
                         <select
                              id="from"
                              value={from}
                              onChange={(e) => {
                                   const v = Number(e.target.value);
                                   setFrom(v);
                                   if (v >= to) setTo(Math.min(v + 1, stops.length - 1));
                              }}
                              className="bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm"
                         >
                              {stops.slice(0, -1).map((s) => (
                                   <option key={s.position} value={s.position}>
                                        {s.label}
                                   </option>
                              ))}
                         </select>
                    </div>

                    <div>
                         <label htmlFor="to" className="label block mb-1.5">
                              To
                         </label>
                         <select
                              id="to"
                              value={to}
                              onChange={(e) => setTo(Number(e.target.value))}
                              className="bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm"
                         >
                              {stops
                                   .filter((s) => s.position > from)
                                   .map((s) => (
                                        <option key={s.position} value={s.position}>
                                             {s.label}
                                        </option>
                                   ))}
                         </select>
                    </div>

                    <div className="ml-auto text-right">
                         <p className="label">Availability as of</p>
                         <p className="font-mono text-xs text-slate-400">
                              {asOf ? new Date(asOf).toLocaleTimeString() : '—'}
                         </p>
                         <p className="text-[10px] text-slate-600 mt-0.5 max-w-[16rem]">
                              May be stale. Checked again when you book.
                         </p>
                    </div>
               </div>

               <div className="flex flex-wrap gap-4 mb-4 text-xs text-slate-400">
                    <Legend className="seat-available" label="Available" />
                    <Legend className="seat-selected" label="Selected" />
                    <Legend className="seat-held" label="Held by someone" />
                    <Legend className="seat-sold" label="Sold" />
                    <Legend className="seat-blocked" label="Withdrawn" />
               </div>

               {!resources && <p className="text-slate-500">Loading seats…</p>}

               <div className="space-y-5">
                    {byGroup.map(([group, seats]) => (
                         <div key={group} className="card p-4">
                              <p className="label mb-3">Coach {group}</p>
                              <div className="flex flex-wrap gap-1.5">
                                   {seats.map((seat) => {
                                        const isSelected = selected.some((s) => s.resourceId === seat.resourceId);
                                        const cls = isSelected
                                             ? 'seat-selected'
                                             : { AVAILABLE: 'seat-available', HELD: 'seat-held', SOLD: 'seat-sold', BLOCKED: 'seat-blocked', RETIRED: 'seat-blocked' }[seat.status];
                                        return (
                                             <button
                                                  key={seat.resourceId}
                                                  onClick={() => toggle(seat)}
                                                  disabled={seat.status !== 'AVAILABLE'}
                                                  title={`${seat.code} · ${seat.status} · ₹${Math.round(seat.priceCents / 100)}`}
                                                  className={`seat ${cls}`}
                                             >
                                                  {seat.code.split('-').pop()}
                                             </button>
                                        );
                                   })}
                              </div>
                         </div>
                    ))}
               </div>

               {error && (
                    <div className="card p-3 mt-4 border-amber-500/40 bg-amber-500/5">
                         <p className="text-sm text-amber-300">{error}</p>
                    </div>
               )}

               {/* Booking bar appears only when there is something to book */}
               {selected.length > 0 && (
                    <div className="sticky bottom-4 mt-6">
                         <div className="card p-4 flex items-center gap-4 border-teal-500/40 bg-[#171b1e]">
                              <div>
                                   <p className="text-sm">
                                        {selected.length} seat{selected.length > 1 ? 's' : ''} · base{' '}
                                        <span className="font-mono">₹{Math.round(total / 100)}</span>
                                        <span className="text-xs text-slate-500"> · final fare priced server-side</span>
                                   </p>
                                   <p className="text-xs text-slate-500 font-mono">
                                        {selected.map((s) => s.code).join(', ')}
                                   </p>
                              </div>
                              <button onClick={book} disabled={booking} className="btn-primary ml-auto">
                                   {booking ? 'Reserving…' : 'Book'}
                              </button>
                         </div>
                    </div>
               )}
          </div>
     );
}

function Legend({ className, label }) {
     return (
          <span className="flex items-center gap-1.5">
               <span className={`${className} !w-4 !h-4`} />
               {label}
          </span>
     );
}
