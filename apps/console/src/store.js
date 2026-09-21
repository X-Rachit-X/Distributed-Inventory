import { create } from 'zustand';
import { setToken } from './api';

/**
 * Auth state.
 *
 * The token is kept in localStorage so a refresh does not log the user out.
 * That is a deliberate trade: it is readable by any script on the origin, which
 * is acceptable for a demo console and would not be for a production system
 * handling real payment identities — there the token would live in an
 * HttpOnly cookie that JavaScript cannot read.
 */
export const useAuth = create((set) => {
     let saved = null;
     try {
          saved = JSON.parse(localStorage.getItem('tessera.auth') || 'null');
     } catch {
          saved = null;
     }
     if (saved?.token) setToken(saved.token);

     return {
          token: saved?.token ?? null,
          customerId: saved?.customerId ?? null,
          email: saved?.email ?? null,
          role: saved?.role ?? 'CUSTOMER',

          signIn: ({ token, customerId, email, role = 'CUSTOMER' }) => {
               setToken(token);
               try {
                    localStorage.setItem('tessera.auth', JSON.stringify({ token, customerId, email, role }));
               } catch {
                    /* private browsing; the session still works in memory */
               }
               set({ token, customerId, email, role });
          },

          signOut: () => {
               setToken(null);
               try {
                    localStorage.removeItem('tessera.auth');
               } catch {
                    /* nothing to clean up */
               }
               set({ token: null, customerId: null, email: null, role: 'CUSTOMER' });
          },
     };
});
