import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../store';

/**
 * Operations — for the OPERATOR role.
 *
 * The scoreboard is public (see Correctness). This page adds the actions an
 * operator takes: reviewing reconciliation issues (money issues always wait
 * here for a human), withdrawing a damaged seat, and switching the fake payment
 * provider's failure mode to demonstrate how the saga behaves.
 */

const MODES = ['ok', 'decline', 'timeout_after_success', 'timeout_before_success', 'duplicate_webhook', 'out_of_order_webhook'];

export default function Operations() {
     const role = useAuth((s) => s.role);
     const [board, setBoard] = useState(null);
     const [issues, setIssues] = useState([]);
     const [message, setMessage] = useState(null);
     const [seatId, setSeatId] = useState('');

     const load = async () => {
          try {
               const [b, i] = await Promise.all([api.scoreboard(), role === 'OPERATOR' ? api.issues('open') : { data: [] }]);
               setBoard(b.data);
               setIssues(i.data);
          } catch (err) {
               setMessage(err.message);
          }
     };

     useEffect(() => {
          load();
          const t = setInterval(load, 5000);
          return () => clearInterval(t);
          // eslint-disable-next-line react-hooks/exhaustive-deps
     }, [role]);

     const act = async (fn, done) => {
          try {
               await fn();
               setMessage(done);
               load();
          } catch (err) {
               setMessage(err.message);
          }
     };

     return (
          <div className="max-w-4xl">
               <h1 className="text-2xl font-semibold mb-1">Operations</h1>
               <p className="text-sm text-slate-400 mb-6">
                    Correctness counters from the reconciliation service. Each should read zero.
               </p>

               {board && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-[#2b3237] border border-[#2b3237] rounded-lg overflow-hidden mb-6">
                         {Object.entries(board.counters).map(([k, v]) => (
                              <div key={k} className="bg-[#171b1e] p-3">
                                   <p className="label">{k.replace(/([A-Z])/g, ' $1')}</p>
                                   <p className={`font-mono text-xl tabular-nums ${v ? 'text-amber-400' : 'text-teal-400'}`}>{v}</p>
                              </div>
                         ))}
                    </div>
               )}
               {board && (
                    <p className="text-xs text-slate-500 font-mono mb-8">
                         correct: {String(board.correct)} · last reconciled{' '}
                         {board.lastReconciledAt ? new Date(board.lastReconciledAt).toLocaleTimeString() : '—'} ·{' '}
                         {board.eventsDeduplicatedAcrossServices} events consumed with dedupe
                    </p>
               )}

               {message && <p className="text-sm text-amber-300 mb-4">{message}</p>}

               {role !== 'OPERATOR' ? (
                    <div className="card p-4 text-sm text-slate-400">
                         Operator actions need the OPERATOR role.
                         {import.meta.env.DEV && (
                              <>
                                   {' '}
                                   Sign in as <span className="font-mono">ops@tessera.dev</span>.
                              </>
                         )}
                    </div>
               ) : (
                    <div className="space-y-6">
                         <section className="card p-4">
                              <div className="flex items-center mb-3">
                                   <p className="label">Open reconciliation issues</p>
                                   <button className="btn-ghost ml-auto" onClick={() => act(api.reconcileNow, 'Reconciliation pass complete')}>
                                        Run reconciliation now
                                   </button>
                              </div>
                              {issues.length === 0 && <p className="text-sm text-slate-500">None. The services agree.</p>}
                              {issues.map((i) => (
                                   <div key={i.id} className="border-t border-[#2b3237] py-3">
                                        <p className="text-sm">
                                             <span className="font-mono text-xs mr-2">{i.severity}</span>
                                             {i.kind}
                                             {i.money_involved && <span className="text-amber-400 text-xs ml-2">money — human decision</span>}
                                        </p>
                                        <p className="text-xs text-slate-400 mt-1">{i.detail}</p>
                                        <p className="text-xs text-slate-500 mt-1">Recommended: {i.recommended_action}</p>
                                        <div className="flex gap-2 mt-2">
                                             <button className="btn-ghost" onClick={() => act(() => api.resolveIssue(i.id, 'resolve', 'handled by operator'), 'Marked resolved')}>Resolve</button>
                                             <button className="btn-ghost" onClick={() => act(() => api.resolveIssue(i.id, 'ignore', 'accepted as benign'), 'Ignored')}>Ignore</button>
                                        </div>
                                   </div>
                              ))}
                         </section>

                         <section className="card p-4">
                              <p className="label mb-3">Withdraw a seat</p>
                              <p className="text-xs text-slate-500 mb-3">
                                   Refused if the seat is held or sold — a customer's claim beats an operator's convenience.
                              </p>
                              <div className="flex gap-2 flex-wrap">
                                   <input id="seat" value={seatId} onChange={(e) => setSeatId(e.target.value)} placeholder="resource id"
                                        className="flex-1 min-w-[16rem] bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm font-mono" />
                                   <button className="btn-ghost" onClick={() => act(() => api.blockSeat(seatId, 'damaged seat'), 'Seat withdrawn')}>Block</button>
                                   <button className="btn-ghost" onClick={() => act(() => api.unblockSeat(seatId, 'repaired'), 'Seat returned')}>Unblock</button>
                              </div>
                         </section>

                         <section className="card p-4">
                              <p className="label mb-3">Payment provider failure mode</p>
                              <div className="flex gap-2 flex-wrap">
                                   {MODES.map((m) => (
                                        <button key={m} className="btn-ghost font-mono text-xs" onClick={() => act(() => api.setProviderMode(m), `Provider mode: ${m}`)}>
                                             {m}
                                        </button>
                                   ))}
                              </div>
                              <p className="text-xs text-slate-500 mt-2">
                                   Try <span className="font-mono">timeout_after_success</span>, then book: the payment goes UNKNOWN, is
                                   resolved with the provider, and the customer is charged once.
                              </p>
                         </section>
                    </div>
               )}
          </div>
     );
}
