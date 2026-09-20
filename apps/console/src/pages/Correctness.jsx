import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The correctness scoreboard.
 *
 * Every row is an invariant checked against the authoritative database, not a
 * metric the application emits about itself. That distinction is the point: an
 * application can be confidently wrong about its own state, so these queries
 * ask PostgreSQL directly.
 *
 * Severity separates two different questions. CRITICAL and HIGH mean inventory
 * is WRONG. MEDIUM means a subsystem is LAGGING — typically events queued while
 * the broker is unavailable — which is an operational concern, not corruption.
 * Showing them identically would train people to ignore both.
 */
export default function Correctness() {
     const [report, setReport] = useState(null);
     const [error, setError] = useState(null);
     const [checkedAt, setCheckedAt] = useState(null);

     useEffect(() => {
          let cancelled = false;

          async function load() {
               try {
                    const result = await api.invariants();
                    if (cancelled) return;
                    setReport(result);
                    setCheckedAt(new Date());
                    setError(null);
               } catch (e) {
                    if (cancelled) return;
                    // The endpoint answers 500 when a correctness invariant is
                    // violated, which is itself the headline.
                    setError(
                         e.status === 500
                              ? 'One or more correctness invariants are violated.'
                              : e.message
                    );
               }
          }

          load();
          const timer = setInterval(load, 5000);
          return () => {
               cancelled = true;
               clearInterval(timer);
          };
     }, []);

     const rows = report?.data ?? [];
     const correctness = rows.filter((r) => ['CRITICAL', 'HIGH'].includes(r.severity));
     const lag = rows.filter((r) => !['CRITICAL', 'HIGH'].includes(r.severity));
     const allCorrect = correctness.length > 0 && correctness.every((r) => Number(r.violations) === 0);

     return (
          <div className="max-w-3xl">
               <h1 className="text-2xl font-semibold mb-1">Correctness</h1>
               <p className="text-sm text-slate-400 mb-6">
                    Queried against the authoritative database, not reported by the application
                    about itself. Refreshes every five seconds.
               </p>

               {error && <p className="text-rose-400 mb-4">{error}</p>}

               <div
                    className={`card p-5 mb-6 ${
                         allCorrect ? 'border-teal-500/40 bg-teal-500/5' : 'border-slate-600/50'
                    }`}
               >
                    <p className="label mb-1">Inventory integrity</p>
                    <p className={`text-2xl font-semibold ${allCorrect ? 'text-teal-300' : 'text-slate-300'}`}>
                         {allCorrect ? 'No oversells, no duplicate bookings' : 'Checking…'}
                    </p>
                    {checkedAt && (
                         <p className="text-xs text-slate-500 font-mono mt-2">
                              checked {checkedAt.toLocaleTimeString()}
                         </p>
                    )}
               </div>

               <Section title="Correctness invariants" rows={correctness} critical />
               {lag.length > 0 && <Section title="Delivery lag" rows={lag} />}

               <p className="text-xs text-slate-600 mt-6 leading-relaxed">
                    These same queries back the integration tests, the benchmark harness and the
                    reconciliation worker, so a benchmark cannot pass using a weaker check than
                    reconciliation applies in production.
               </p>
          </div>
     );
}

function Section({ title, rows, critical = false }) {
     if (rows.length === 0) return null;
     return (
          <div className="mb-6">
               <p className="label mb-2">{title}</p>
               <div className="card divide-y divide-[#2b3237]">
                    {rows.map((r) => {
                         const n = Number(r.violations);
                         const bad = n > 0;
                         const tone = bad ? (critical ? 'rose' : 'amber') : 'teal';
                         return (
                              <div key={r.invariant} className="px-4 py-3 flex items-center gap-3">
                                   <span
                                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                             tone === 'rose'
                                                  ? 'bg-rose-500'
                                                  : tone === 'amber'
                                                    ? 'bg-amber-500'
                                                    : 'bg-teal-500'
                                        }`}
                                   />
                                   <span className="font-mono text-xs text-slate-300 truncate">{r.invariant}</span>
                                   <span className="label ml-auto shrink-0">{r.severity}</span>
                                   <span
                                        className={`font-mono tabular-nums w-12 text-right shrink-0 ${
                                             tone === 'rose'
                                                  ? 'text-rose-400'
                                                  : tone === 'amber'
                                                    ? 'text-amber-400'
                                                    : 'text-teal-400'
                                        }`}
                                   >
                                        {n}
                                   </span>
                              </div>
                         );
                    })}
               </div>
          </div>
     );
}
