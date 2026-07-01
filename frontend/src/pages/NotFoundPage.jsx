import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <div className="section-container py-20 text-center">
      <div className="max-w-md mx-auto">
        <div className="w-20 h-20 rounded-3xl bg-gradient-to-br from-primary-100 to-primary-200 flex items-center justify-center mx-auto mb-6 text-primary-600">
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
            <circle cx="20" cy="20" r="16" stroke="currentColor" strokeWidth="2.5"/>
            <path d="M20 12v9M20 25v2" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        </div>
        <h1 className="font-display text-6xl font-bold text-surface-200 mb-2">404</h1>
        <h2 className="font-display text-xl font-bold text-surface-900 mb-3">Page not found</h2>
        <p className="text-surface-500 text-sm mb-8">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <Link to="/" className="btn-primary inline-flex">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
