import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../store/auth.store';
import { authApi } from '../api/auth.api';
import { useToast } from '../components/ui/Toast';
import Button from '../components/ui/Button';
import Input from '../components/ui/Input';

const TRAIN_SVG = (
  <svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="8" y="18" width="40" height="24" rx="7" fill="white" fillOpacity="0.15"/>
    <rect x="8" y="18" width="40" height="24" rx="7" stroke="white" strokeWidth="1.5" strokeOpacity="0.3"/>
    <rect x="14" y="23" width="9" height="9" rx="2" fill="white" fillOpacity="0.7"/>
    <rect x="26" y="23" width="9" height="9" rx="2" fill="white" fillOpacity="0.7"/>
    <circle cx="16" cy="44" r="5" fill="white" fillOpacity="0.3" stroke="white" strokeWidth="1.5"/>
    <circle cx="40" cy="44" r="5" fill="white" fillOpacity="0.3" stroke="white" strokeWidth="1.5"/>
    <rect x="6" y="48" width="44" height="2.5" rx="1.25" fill="white" fillOpacity="0.2"/>
    <rect x="6" y="15" width="12" height="2.5" rx="1.25" fill="white" fillOpacity="0.25"/>
    <rect x="6" y="11" width="8" height="2.5" rx="1.25" fill="white" fillOpacity="0.15"/>
  </svg>
);

export default function LoginPage() {
  const [tab, setTab] = useState('login'); // login | register | otp
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const setUser = useAuthStore((s) => s.setUser);
  const showToast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [regData, setRegData] = useState({ firstName: '', lastName: '', email: '', password: '', confirmPassword: '' });
  const [otp, setOtp] = useState('');

  const redirect = searchParams.get('redirect') || '/';

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login(email, password);
      const user = res.loggedInUser || res.data?.user || res.data;
      setUser(user);
      showToast('Welcome back!', 'success');
      navigate(redirect, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    if (regData.password !== regData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setLoading(true);
    try {
      await authApi.sendOtp(regData);
      showToast('OTP sent to your email!', 'success');
      setTab('otp');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await authApi.verifyOtp(otp);
      showToast('Email verified! Please log in.', 'success');
      setEmail(regData.email);
      setTab('login');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-[calc(100vh-64px)] flex">
      {/* ── Left branding panel ── */}
      <div className="hidden lg:flex flex-col justify-between w-2/5 bg-hero-gradient p-12 relative overflow-hidden">
        <div className="absolute inset-0 hero-dots pointer-events-none" />
        <div className="absolute -top-20 -right-20 w-72 h-72 rounded-full bg-accent-500/10 blur-3xl" />
        <div className="absolute -bottom-20 -left-20 w-72 h-72 rounded-full bg-primary-500/20 blur-3xl" />

        <div className="relative">
          <div className="flex items-center gap-3 mb-12">
            <div className="w-10 h-10 rounded-xl bg-white/15 border border-white/20 flex items-center justify-center">
              {TRAIN_SVG}
            </div>
            <span className="font-display text-2xl font-bold text-white">
              Scale<span className="text-accent-400">Rail</span>
            </span>
          </div>

          <h2 className="font-display text-4xl font-bold text-white leading-tight mb-4">
            Your journey<br/>starts here.
          </h2>
          <p className="text-primary-200 leading-relaxed">
            Book train tickets, track your trips, and travel smarter — all in one place.
          </p>
        </div>

        {/* Feature bullets */}
        <div className="relative space-y-4">
          {[
            'Real-time seat availability',
            'Secure Razorpay payments',
            'Instant email confirmations',
            'Segment & partial-route booking',
          ].map((item, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="flex-shrink-0 w-5 h-5 rounded-full bg-accent-400/20 border border-accent-400/40 flex items-center justify-center">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <path d="M2 5l2 2 4-4" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="text-sm text-primary-100">{item}</span>
            </div>
          ))}
        </div>

        <p className="relative text-xs text-primary-400 mt-8">
          © {new Date().getFullYear()} ScaleRail. All rights reserved.
        </p>
      </div>

      {/* ── Right form panel ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12 bg-surface-50">
        <div className="w-full max-w-md animate-fade-up">
          {/* Mobile logo */}
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <span className="font-display text-2xl font-bold text-surface-900">
              Scale<span className="text-primary-600">Rail</span>
            </span>
          </div>

          <div className="mb-8">
            <h1 className="font-display text-3xl font-bold text-surface-900">
              {tab === 'otp' ? 'Verify your email' : tab === 'login' ? 'Welcome back' : 'Create account'}
            </h1>
            <p className="text-surface-500 mt-1.5 text-sm">
              {tab === 'otp'
                ? `We sent a code to ${regData.email}`
                : tab === 'login'
                  ? 'Sign in to your ScaleRail account'
                  : 'Start booking smarter today'}
            </p>
          </div>

          <div className="card shadow-card">
            {/* Tabs */}
            {tab !== 'otp' && (
              <div className="flex mb-6 rounded-xl bg-surface-100 p-1">
                {['login', 'register'].map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTab(t); setError(''); }}
                    className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
                      tab === t
                        ? 'bg-white text-primary-700 shadow-sm'
                        : 'text-surface-500 hover:text-surface-700'
                    }`}
                  >
                    {t === 'login' ? 'Sign In' : 'Register'}
                  </button>
                ))}
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0 mt-0.5">
                  <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M8 5v3.5M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                {error}
              </div>
            )}

            {/* Login Form */}
            {tab === 'login' && (
              <form onSubmit={handleLogin} className="space-y-4">
                <Input id="login-email" label="Email address" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required />
                <Input id="login-password" label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
                <Button id="login-submit" type="submit" loading={loading} className="w-full mt-2">Sign In</Button>
              </form>
            )}

            {/* Register Form */}
            {tab === 'register' && (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Input id="reg-first" label="First Name" value={regData.firstName} onChange={(e) => setRegData({ ...regData, firstName: e.target.value })} required />
                  <Input id="reg-last" label="Last Name" value={regData.lastName} onChange={(e) => setRegData({ ...regData, lastName: e.target.value })} required />
                </div>
                <Input id="reg-email" label="Email address" type="email" value={regData.email} onChange={(e) => setRegData({ ...regData, email: e.target.value })} required />
                <Input id="reg-password" label="Password" type="password" value={regData.password} onChange={(e) => setRegData({ ...regData, password: e.target.value })} required />
                <Input id="reg-confirm" label="Confirm Password" type="password" value={regData.confirmPassword} onChange={(e) => setRegData({ ...regData, confirmPassword: e.target.value })} required />
                <Button id="register-submit" type="submit" loading={loading} className="w-full mt-2">Create Account</Button>
              </form>
            )}

            {/* OTP Form */}
            {tab === 'otp' && (
              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <Input id="otp-code" label="Verification Code" value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="Enter 6-digit code" maxLength={6} required />
                <Button id="otp-submit" type="submit" loading={loading} className="w-full">Verify Email</Button>
                <button type="button" onClick={() => setTab('register')} className="text-sm text-primary-600 hover:text-primary-700 w-full text-center transition-colors">
                  ← Back to register
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
