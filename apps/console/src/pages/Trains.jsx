import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Trains() {
     const [events, setEvents] = useState(null);
     const [error, setError] = useState(null);

     useEffect(() => {
          api.listEvents()
               .then((r) => setEvents(r.data))
               .catch((e) => setError(e.message));
     }, []);

     if (error) return <p className="text-rose-400">{error}</p>;
     if (!events) return <p className="text-slate-500">Loading…</p>;

     return (
          <div>
               <h1 className="text-2xl font-semibold mb-1">Departures</h1>
               <p className="text-sm text-slate-400 mb-6">
                    Seat counts are a live read, but they are discovery data — the reserve step
                    re-checks against the authoritative database, so a seat can be taken between
                    this page and your click.
               </p>

               <div className="grid gap-3 sm:grid-cols-2">
                    {events.map((e) => {
                         const soldOut = e.availableResources === 0;
                         return (
                              <Link
                                   key={e.eventId}
                                   to={`/trains/${e.eventId}`}
                                   className="card p-4 hover:border-teal-500/50 transition-colors block"
                              >
                                   <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                             <p className="font-medium truncate">{e.name}</p>
                                             <p className="text-xs text-slate-500 font-mono mt-0.5">
                                                  {new Date(e.startsAt).toLocaleString()}
                                             </p>
                                        </div>
                                        <div className="text-right shrink-0">
                                             <p
                                                  className={`font-mono text-lg tabular-nums ${
                                                       soldOut ? 'text-slate-600' : 'text-teal-400'
                                                  }`}
                                             >
                                                  {e.availableResources}
                                             </p>
                                             <p className="label">of {e.totalResources}</p>
                                        </div>
                                   </div>
                              </Link>
                         );
                    })}
               </div>
          </div>
     );
}
