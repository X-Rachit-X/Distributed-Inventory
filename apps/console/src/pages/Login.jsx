import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../store';

export default function Login() {
     const [email, setEmail] = useState('');
     const [busy, setBusy] = useState(false);
     const [error, setError] = useState(null);
     const signIn = useAuth((s) => s.signIn);
     const navigate = useNavigate();
     const location = useLocation();

     async function submit(e) {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
               const { data } = await api.login(email);
               signIn({ ...data, email });
               navigate(location.state?.from || '/trains', { replace: true });
          } catch (err) {
               setError(err.message);
          } finally {
               setBusy(false);
          }
     }

     return (
          <div className="max-w-sm mx-auto mt-16">
               <h1 className="text-2xl font-semibold mb-1">Sign in</h1>
               <p className="text-sm text-slate-400 mb-6">
                    Any email works. This console demonstrates inventory correctness, not
                    credential handling, so authentication is deliberately minimal.
               </p>

               <form onSubmit={submit} className="card p-5 space-y-4">
                    <div>
                         <label htmlFor="email" className="label block mb-1.5">
                              Email
                         </label>
                         <input
                              id="email"
                              type="email"
                              required
                              value={email}
                              onChange={(e) => setEmail(e.target.value)}
                              placeholder="you@example.com"
                              className="w-full bg-[#0f1214] border border-[#2b3237] rounded-md px-3 py-2 text-sm
                                         focus:outline-none focus:border-teal-500"
                         />
                    </div>

                    {error && <p className="text-sm text-rose-400">{error}</p>}

                    <button type="submit" disabled={busy} className="btn-primary w-full">
                         {busy ? 'Signing in…' : 'Continue'}
                    </button>
               </form>
          </div>
     );
}
