import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import SearchForm from '../components/search/SearchForm';
import BookingCard from '../components/bookings/BookingCard';
import { useAuthStore } from '../store/auth.store';
import { bookingApi } from '../api/booking.api';

const FEATURES = [
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        <path d="M18 18l5 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
      </svg>
    ),
    title: 'Fuzzy Station Search',
    desc: 'Find trains with smart full-text search across 500+ stations using Elasticsearch.',
    color: 'from-primary-500 to-primary-600',
    bg: 'bg-primary-50',
    text: 'text-primary-600',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <rect x="4" y="8" width="20" height="14" rx="3" stroke="currentColor" strokeWidth="2"/>
        <path d="M8 8V6a4 4 0 018 0v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        <circle cx="14" cy="15" r="2" fill="currentColor"/>
      </svg>
    ),
    title: 'Real-time Seat Lock',
    desc: 'Seats are reserved via Redis for 10 minutes while you pay — no double bookings, ever.',
    color: 'from-emerald-500 to-teal-500',
    bg: 'bg-emerald-50',
    text: 'text-emerald-600',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M14 4l2.5 7.5H24l-6 4.5 2.5 7.5L14 19l-6.5 4.5 2.5-7.5-6-4.5h7.5L14 4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
      </svg>
    ),
    title: 'Segment Booking',
    desc: 'Book any origin→destination pair on a train, not just endpoints. True partial-route support.',
    color: 'from-violet-500 to-purple-600',
    bg: 'bg-violet-50',
    text: 'text-violet-600',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M6 12h16M6 16h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        <rect x="4" y="6" width="20" height="16" rx="3" stroke="currentColor" strokeWidth="2"/>
        <circle cx="21" cy="21" r="4" fill="currentColor" className="text-accent-400"/>
        <path d="M19.5 21h3M21 19.5v3" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
    ),
    title: 'Secure Payments',
    desc: 'Razorpay integration with signature verification and automated refunds on cancellation.',
    color: 'from-accent-500 to-orange-500',
    bg: 'bg-accent-50',
    text: 'text-accent-600',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <path d="M4 14h4l3 6 6-12 3 6h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
    title: 'Event-Driven Core',
    desc: 'Kafka-powered async saga handles booking → payment → confirmation with zero data loss.',
    color: 'from-rose-500 to-pink-600',
    bg: 'bg-rose-50',
    text: 'text-rose-600',
  },
  {
    icon: (
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
        <circle cx="14" cy="14" r="10" stroke="currentColor" strokeWidth="2"/>
        <path d="M14 9v5l3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      </svg>
    ),
    title: 'Instant Notifications',
    desc: 'Email confirmations and updates sent via the notification microservice on every status change.',
    color: 'from-cyan-500 to-blue-500',
    bg: 'bg-cyan-50',
    text: 'text-cyan-600',
  },
];

const STATS = [
  { value: '7', label: 'Microservices' },
  { value: 'Kafka', label: 'Event Bus' },
  { value: 'Redis', label: 'Seat Locks' },
  { value: '99.9%', label: 'Uptime SLA' },
];

export default function HomePage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [recentBookings, setRecentBookings] = useState([]);

  useEffect(() => {
    if (isAuthenticated) {
      bookingApi.list(null, 1, 3).then((res) => {
        const data = res.data || res;
        setRecentBookings(data.bookings || []);
      }).catch(() => {});
    }
  }, [isAuthenticated]);

  return (
    <div className="min-h-screen">
      {/* ── Hero Section ─────────────────────────────────────────────── */}
      <section className="relative bg-hero-gradient overflow-hidden">
        {/* Dot pattern overlay */}
        <div className="absolute inset-0 hero-dots pointer-events-none" />

        {/* Glowing orbs */}
        <div className="absolute -top-32 -left-32 w-96 h-96 rounded-full bg-primary-500/20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-20 -right-20 w-80 h-80 rounded-full bg-accent-500/15 blur-3xl pointer-events-none" />

        <div className="section-container relative py-20 md:py-28">
          {/* Badge */}
          <div className="flex justify-start mb-6 animate-fade-up">
            <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/10 border border-white/20 text-xs font-semibold text-white/80 backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-accent-400 animate-pulse" />
              Production-grade microservices platform
            </span>
          </div>

          <h1 className="font-display text-4xl md:text-6xl font-bold text-white leading-tight mb-4 animate-fade-up animate-delay-100">
            Book smarter.<br/>
            <span className="text-gradient bg-gradient-to-r from-accent-300 to-accent-400">Travel better.</span>
          </h1>
          <p className="text-primary-200 text-lg md:text-xl mb-10 max-w-xl animate-fade-up animate-delay-200">
            Search trains, pick your seats, pay in seconds. ScaleRail is built for speed, reliability, and scale.
          </p>

          {/* Search Panel */}
          <div className="glass p-6 md:p-8 shadow-2xl max-w-4xl animate-fade-up animate-delay-300">
            <p className="text-white/60 text-xs font-semibold uppercase tracking-widest mb-5">Find your next journey</p>
            <SearchForm />
          </div>
        </div>
      </section>

      {/* ── Stats Strip ──────────────────────────────────────────────── */}
      <section className="bg-primary-900 border-y border-primary-800">
        <div className="section-container py-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
            {STATS.map((stat, i) => (
              <div key={i} className="text-center">
                <p className="font-display text-2xl font-bold text-white">{stat.value}</p>
                <p className="text-xs text-primary-400 mt-0.5">{stat.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features Grid ────────────────────────────────────────────── */}
      <section className="section-container py-20">
        <div className="text-center mb-12">
          <h2 className="font-display text-3xl font-bold text-surface-900 mb-3">
            Everything built for scale
          </h2>
          <p className="text-surface-500 max-w-md mx-auto">
            Every feature is backed by a dedicated microservice — independently deployable, independently scalable.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map((f, i) => (
            <div
              key={i}
              className={`card-hover group animate-fade-up`}
              style={{ animationDelay: `${i * 80}ms`, opacity: 0, animation: `fade-up 0.5s ease-out ${i * 80}ms forwards` }}
            >
              <div className={`inline-flex items-center justify-center w-12 h-12 rounded-xl ${f.bg} ${f.text} mb-4 group-hover:scale-110 transition-transform duration-300`}>
                {f.icon}
              </div>
              <h3 className="font-display font-semibold text-surface-900 mb-2">{f.title}</h3>
              <p className="text-sm text-surface-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Recent Bookings ──────────────────────────────────────────── */}
      {isAuthenticated && recentBookings.length > 0 && (
        <section className="bg-surface-100 border-t border-surface-200">
          <div className="section-container py-12">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-display text-xl font-bold text-surface-900">Recent Journeys</h2>
              <Link
                to="/bookings"
                className="text-sm font-medium text-primary-600 hover:text-primary-700 flex items-center gap-1 transition-colors"
              >
                View all
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M6 12l4-4-4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </Link>
            </div>
            <div className="space-y-3">
              {recentBookings.map((b) => <BookingCard key={b.id} booking={b} />)}
            </div>
          </div>
        </section>
      )}

      {/* ── CTA ──────────────────────────────────────────────────────── */}
      {!isAuthenticated && (
        <section className="section-container py-20 text-center">
          <div className="max-w-lg mx-auto card p-10 bg-gradient-to-br from-primary-50 to-white">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center mx-auto mb-6 shadow-glow">
              <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
                <path d="M6 12h16M6 16h10" stroke="white" strokeWidth="2" strokeLinecap="round"/>
                <rect x="4" y="6" width="20" height="16" rx="3" stroke="white" strokeWidth="2"/>
              </svg>
            </div>
            <h2 className="font-display text-2xl font-bold text-surface-900 mb-3">Ready to travel?</h2>
            <p className="text-surface-500 text-sm mb-6 leading-relaxed">
              Create a free account to book seats, track bookings, and get instant email confirmations.
            </p>
            <Link to="/login" className="btn-primary w-full justify-center">
              Create Free Account
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
