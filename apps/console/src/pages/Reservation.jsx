import { useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';

/**
 * Live reservation progress.
 *
 * This page exists because the booking flow is ASYNCHRONOUS. The API returns
 * the moment the reservation is durable, and a saga drives the rest: hold,
 * charge, confirm. Showing those steps is honest about what the system is
 * doing, and it is the clearest demonstration that progress lives in the
 * database rather than in a request that has to be held open.
 *
 * Polling backs off once settled and stops entirely — a page left open on a
 * finished booking should not keep asking.
 */

const STEPS = [
     { key: 'hold', label: 'Securing seats', states: ['HOLD_PENDING', 'Securing your seats'] },
     { key: 'pay', label: 'Taking payment', states: ['PAYMENT_PENDING', 'Processing payment'] },
     { key: 'confirm', label: 'Issuing booking', states: ['CONFIRM_PENDING', 'Issuing your booking'] },
];

export default function Reservation() {
     const { id } = useParams();
     const [reservation, setReservation] = useState(null);
     const [error, setError] = useState(null);
     const [elapsed, setElapsed] = useState(0);
     const timer = useRef(null);
     const startedAt = useRef(Date.now());

     useEffect(() => {
          let cancelled = false;

          async function poll() {
               try {
                    const { data } = await api.getReservation(id);
                    if (cancelled) return;
                    setReservation(data);
                    setElapsed(Date.now() - startedAt.current);

                    // Stop once there is nothing left to watch.
                    if (!data.settled) {
                         timer.current = setTimeout(poll, 400);
                    }
               } catch (err) {
                    if (!cancelled) setError(err.message);
               }
          }

          poll();
          return () => {
               cancelled = true;
               if (timer.current) clearTimeout(timer.current);
          };
     }, [id]);

     if (error) return <p className="text-rose-400">{error}</p>;
     if (!reservation) return <p className="text-slate-500">Loading…</p>;

     const confirmed = reservation.state === 'CONFIRMED';
     const failed = ['FAILED', 'CANCELLED', 'EXPIRED'].includes(reservation.state);
     const underReview = reservation.progress === 'Under review by our team';

     return (
          <div className="max-w-2xl">
               <Link to="/bookings" className="text-sm text-slate-400 hover:text-slate-200">
                    ← My bookings
               </Link>

               <div className="card p-6 mt-4">
                    <div className="flex items-start justify-between gap-4 mb-6">
                         <div>
                              <p className="label mb-1">Reservation</p>
                              <p className="font-mono text-xs text-slate-400 break-all">{reservation.reservationId}</p>
                         </div>
                         <StateBadge state={reservation.state} />
                    </div>

                    {/* Progress. Each step is a real saga transition, not a decoration. */}
                    <div className="space-y-2 mb-6">
                         {STEPS.map((step, i) => {
                              const status = stepStatus(step, reservation, i);
                              return (
                                   <div key={step.key} className="flex items-center gap-3">
                                        <StepDot status={status} />
                                        <span
                                             className={`text-sm ${
                                                  status === 'done'
                                                       ? 'text-slate-400'
                                                       : status === 'active'
                                                         ? 'text-teal-300'
                                                         : status === 'failed'
                                                           ? 'text-rose-400'
                                                           : 'text-slate-600'
                                             }`}
                                        >
                                             {step.label}
                                        </span>
                                        {status === 'active' && (
                                             <span className="text-xs text-slate-600 font-mono ml-auto">
                                                  {(elapsed / 1000).toFixed(1)}s
                                             </span>
                                        )}
                                   </div>
                              );
                         })}
                    </div>

                    <div className="border-t border-[#2b3237] pt-4">
                         <p className="text-sm text-slate-300">{reservation.progress}</p>

                         {underReview && (
                              <p className="text-xs text-amber-400/80 mt-2">
                                   Your payment is being verified with the provider. Nothing will be charged
                                   twice — we confirm with them before taking any further action.
                              </p>
                         )}

                         {reservation.failureReason && !confirmed && (
                              <p className="text-xs text-slate-500 mt-2 font-mono">{reservation.failureReason}</p>
                         )}
                    </div>

                    {confirmed && (
                         <div className="mt-6 p-4 rounded-md bg-teal-500/10 border border-teal-500/30">
                              <p className="label mb-1">Booking reference</p>
                              <p className="font-mono text-2xl text-teal-300">{reservation.bookingReference}</p>
                         </div>
                    )}

                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 mt-6 text-sm">
                         <div>
                              <dt className="label mb-0.5">Seats</dt>
                              <dd className="font-mono">
                                   {reservation.items.map((i) => i.resourceCode).filter(Boolean).join(', ') ||
                                        reservation.itemCount}
                              </dd>
                         </div>
                         <div>
                              <dt className="label mb-0.5">Total</dt>
                              <dd className="font-mono tabular-nums">
                                   ₹{Math.round(reservation.totalCents / 100)}
                              </dd>
                         </div>
                         {reservation.holdExpiresAt && !confirmed && !failed && (
                              <div className="col-span-2">
                                   <dt className="label mb-0.5">Hold expires</dt>
                                   <dd className="font-mono text-amber-400/80">
                                        {new Date(reservation.holdExpiresAt).toLocaleTimeString()}
                                   </dd>
                              </div>
                         )}
                    </dl>

                    {failed && (
                         <Link to="/trains" className="btn-ghost inline-block mt-6">
                              Choose another seat
                         </Link>
                    )}
               </div>
          </div>
     );
}

/** Where a step stands, derived from the saga's reported progress. */
function stepStatus(step, reservation, index) {
     const order = ['Securing your seats', 'Processing payment', 'Issuing your booking'];
     const current = order.indexOf(reservation.progress);

     if (reservation.state === 'CONFIRMED') return 'done';
     if (['FAILED', 'CANCELLED', 'EXPIRED'].includes(reservation.state)) {
          // Mark the step that failed, and leave earlier ones as completed.
          return current === -1 ? (index === 0 ? 'failed' : 'idle') : index < current ? 'done' : index === current ? 'failed' : 'idle';
     }
     if (current === -1) return index === 0 ? 'active' : 'idle';
     return index < current ? 'done' : index === current ? 'active' : 'idle';
}

function StepDot({ status }) {
     const base = 'w-2.5 h-2.5 rounded-full shrink-0';
     if (status === 'done') return <span className={`${base} bg-teal-500`} />;
     if (status === 'active')
          return <span className={`${base} bg-teal-400 animate-pulse ring-4 ring-teal-400/20`} />;
     if (status === 'failed') return <span className={`${base} bg-rose-500`} />;
     return <span className={`${base} bg-slate-700`} />;
}

function StateBadge({ state }) {
     const styles = {
          CONFIRMED: 'bg-teal-500/15 text-teal-300 border-teal-500/40',
          PENDING: 'bg-slate-500/15 text-slate-300 border-slate-500/40',
          HELD: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
          AWAITING_PAYMENT: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
          FAILED: 'bg-rose-500/15 text-rose-300 border-rose-500/40',
          CANCELLED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
          EXPIRED: 'bg-slate-600/20 text-slate-400 border-slate-600/40',
     };
     return (
          <span
               className={`font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border ${
                    styles[state] ?? styles.PENDING
               }`}
          >
               {state}
          </span>
     );
}
