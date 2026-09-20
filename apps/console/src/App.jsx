import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './store';
import Login from './pages/Login';
import Trains from './pages/Trains';
import SeatMap from './pages/SeatMap';
import Reservation from './pages/Reservation';
import MyBookings from './pages/MyBookings';
import Correctness from './pages/Correctness';

function RequireAuth({ children }) {
     const token = useAuth((s) => s.token);
     const location = useLocation();
     // Remember where they were headed, so signing in returns them there
     // instead of dumping them on the home page.
     if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
     return children;
}

function NavLink({ to, children }) {
     const { pathname } = useLocation();
     const active = pathname === to || (to !== '/' && pathname.startsWith(to));
     return (
          <Link
               to={to}
               className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    active ? 'bg-[#1f2428] text-teal-300' : 'text-slate-400 hover:text-slate-200'
               }`}
          >
               {children}
          </Link>
     );
}

export default function App() {
     const { token, email, signOut } = useAuth();

     return (
          <div className="min-h-screen">
               <header className="border-b border-[#2b3237] sticky top-0 bg-[#0f1214]/95 backdrop-blur z-10">
                    <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2">
                         <Link to="/" className="font-mono font-semibold text-teal-400 mr-4 tracking-tight">
                              tessera
                         </Link>
                         <NavLink to="/trains">Trains</NavLink>
                         {token && <NavLink to="/bookings">My bookings</NavLink>}
                         <NavLink to="/correctness">Correctness</NavLink>

                         <div className="ml-auto flex items-center gap-3">
                              {token ? (
                                   <>
                                        <span className="text-xs text-slate-500 font-mono hidden sm:inline">
                                             {email}
                                        </span>
                                        <button onClick={signOut} className="text-xs text-slate-400 hover:text-slate-200">
                                             Sign out
                                        </button>
                                   </>
                              ) : (
                                   <Link to="/login" className="btn-primary">
                                        Sign in
                                   </Link>
                              )}
                         </div>
                    </div>
               </header>

               <main className="max-w-6xl mx-auto px-4 py-8">
                    <Routes>
                         <Route path="/" element={<Navigate to="/trains" replace />} />
                         <Route path="/login" element={<Login />} />
                         <Route path="/trains" element={<Trains />} />
                         <Route
                              path="/trains/:eventId"
                              element={
                                   <RequireAuth>
                                        <SeatMap />
                                   </RequireAuth>
                              }
                         />
                         <Route
                              path="/reservations/:id"
                              element={
                                   <RequireAuth>
                                        <Reservation />
                                   </RequireAuth>
                              }
                         />
                         <Route
                              path="/bookings"
                              element={
                                   <RequireAuth>
                                        <MyBookings />
                                   </RequireAuth>
                              }
                         />
                         <Route path="/correctness" element={<Correctness />} />
                         <Route path="*" element={<Navigate to="/trains" replace />} />
                    </Routes>
               </main>
          </div>
     );
}
