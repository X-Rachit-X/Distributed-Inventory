import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

/**
 * Search — backed by the discovery service.
 *
 * Results are a read model, not the inventory itself. The page shows which
 * backend answered (Elasticsearch, or PostgreSQL when ES is down), whether the
 * answer came from cache, and how old it is. A seat shown here can be gone by
 * the time you click; the booking step re-checks against the authority.
 */

const CLASSES = ['', '1A', '2A', '3A', 'SL'];
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

export default function Search() {
     const [form, setForm] = useState({ from: 'NDLS', to: 'HWH', date: tomorrow(), class: '', onlyAvailable: true });
     const [result, setResult] = useState(null);
     const [error, setError] = useState(null);
     const [busy, setBusy] = useState(false);

     async function run(e) {
          e?.preventDefault();
          setBusy(true);
          setError(null);
          try {
               const params = Object.fromEntries(
                    Object.entries({ ...form, onlyAvailable: String(form.onlyAvailable) }).filter(([, v]) => v !== '')
               );
               setResult(await api.search(params));
          } catch (err) {
               setError(err.message);
          } finally {
               setBusy(false);
          }
     }

     useEffect(() => {
          run();
          // eslint-disable-next-line react-hooks/exhaustive-deps
     }, []);

     const set = (k) => (e) =>
          setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

     return (
          <div>
               <h1 className="text-2xl font-semibold mb-1">Find a train</h1>
               <p className="text-sm text-slate-400 mb-6">
                    Station names are typo-tolerant — try <span className="font-mono">kanpr</span> or{' '}
                    <span className="font-mono">howra</span>.
               </p>

               <form onSubmit={run} className="card p-4 mb-6 grid gap-3 sm:grid-cols-6 items-end">
                    <Field id="from" label="From" value={form.from} onChange={set('from')} />
                    <Field id="to" label="To" value={form.to} onChange={set('to')} />
                    <Field id="date" label="Date" type="date" value={form.date} onChange={set('date')} />
                    <div>
                         <label htmlFor="class" className="label block mb-1.5">Class</label>
                         <select id="class" value={form.class} onChange={set('class')}
                              className="w-full bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm">
                              {CLASSES.map((c) => <option key={c} value={c}>{c || 'Any'}</option>)}
                         </select>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-300 pb-2">
                         <input id="onlyAvailable" type="checkbox" checked={form.onlyAvailable} onChange={set('onlyAvailable')} />
                         Available only
                    </label>
                    <button className="btn-primary" disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
               </form>

               {error && <p className="text-rose-400 mb-4">{error}</p>}

               {result && (
                    <p className="text-xs text-slate-500 font-mono mb-3">
                         {result.data.length} result(s) · backend {result.backend} · cache {result.cache} · data{' '}
                         {result.ageSeconds}s old · not authoritative
                    </p>
               )}

               <div className="space-y-3">
                    {result?.data.map((r) => (
                         <div key={`${r.eventId}-${r.from.position}-${r.to.position}`} className="card p-4">
                              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-3">
                                   <p className="font-medium">{r.name}</p>
                                   <p className="text-sm text-slate-400">
                                        {r.from.label} <span className="font-mono">{time(r.departAt)}</span> →{' '}
                                        {r.to.label} <span className="font-mono">{time(r.arriveAt)}</span>
                                   </p>
                                   <p className="text-xs text-slate-500 font-mono">
                                        {Math.floor(r.durationMinutes / 60)}h {r.durationMinutes % 60}m
                                   </p>
                                   <Link
                                        to={`/trains/${r.eventId}?from=${r.from.position}&to=${r.to.position}`}
                                        className="btn-ghost ml-auto"
                                   >
                                        Choose seats
                                   </Link>
                              </div>
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                                   {r.classes.map((c) => (
                                        <div key={c.class} className="rounded-md border border-[#2b3237] px-3 py-2">
                                             <div className="flex justify-between">
                                                  <span className="font-mono text-sm">{c.class}</span>
                                                  <span className={`font-mono text-sm ${c.available ? 'text-teal-400' : 'text-slate-600'}`}>
                                                       {c.available}/{c.total}
                                                  </span>
                                             </div>
                                             <p className="text-xs text-slate-400 font-mono mt-1">
                                                  ₹{Math.round(c.fareCents / 100)}
                                                  {c.tier && c.tier !== 'STANDARD' && (
                                                       <span className="text-amber-400/80 ml-1">{c.tier.replace('_', ' ').toLowerCase()}</span>
                                                  )}
                                             </p>
                                        </div>
                                   ))}
                              </div>
                         </div>
                    ))}
               </div>
          </div>
     );
}

function Field({ id, label, ...props }) {
     return (
          <div>
               <label htmlFor={id} className="label block mb-1.5">{label}</label>
               <input id={id} {...props}
                    className="w-full bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-teal-500" />
          </div>
     );
}

const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
