import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function MyBookings() {
     const [items, setItems] = useState(null);
     const [error, setError] = useState(null);

     const load = () =>
          api
               .listReservations()
               .then((r) => setItems(r.data))
               .catch((e) => setError(e.message));

     useEffect(() => {
          load();
     }, []);

     async function cancel(id) {
          try {
               await api.cancel(id);
               load();
          } catch (e) {
               setError(e.message);
          }
     }

     if (error) return <p className="text-rose-400">{error}</p>;
     if (!items) return <p className="text-slate-500">Loading…</p>;

     if (items.length === 0) {
          return (
               <div className="text-center py-16">
                    <p className="text-slate-400 mb-4">No bookings yet.</p>
                    <Link to="/trains" className="btn-primary inline-block">
                         Find a train
                    </Link>
               </div>
          );
     }

     return (
          <div>
               <h1 className="text-2xl font-semibold mb-6">My bookings</h1>
               <div className="space-y-2">
                    {items.map((r) => {
                         const cancellable = !['CANCELLED', 'FAILED', 'EXPIRED'].includes(r.state);
                         return (
                              <div key={r.id} className="card p-4 flex items-center gap-4 flex-wrap">
                                   <div className="min-w-0">
                                        <p className="font-mono text-sm">
                                             {r.reference || <span className="text-slate-500">no reference yet</span>}
                                        </p>
                                        <p className="text-xs text-slate-500 mt-0.5">
                                             {r.item_count} seat{r.item_count > 1 ? 's' : ''} · ₹
                                             {Math.round(r.total_cents / 100)} ·{' '}
                                             {new Date(r.created_at).toLocaleString()}
                                        </p>
                                   </div>
                                   <span className="font-mono text-[10px] uppercase tracking-wider text-slate-400 ml-auto shrink-0">
                                        {r.state}
                                   </span>
                                   <Link to={`/reservations/${r.id}`} className="btn-ghost shrink-0">
                                        View
                                   </Link>
                                   {cancellable && (
                                        <button onClick={() => cancel(r.id)} className="btn-ghost shrink-0">
                                             Cancel
                                        </button>
                                   )}
                              </div>
                         );
                    })}
               </div>
          </div>
     );
}
