export default function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-surface-900 text-surface-400 mt-auto">
      <div className="section-container py-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mb-10">
          {/* Brand */}
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                  <rect x="2" y="7" width="16" height="8" rx="2.5" fill="white" fillOpacity="0.95"/>
                  <rect x="4" y="8.5" width="3" height="3" rx="0.75" fill="#4338ca"/>
                  <rect x="8.5" y="8.5" width="3" height="3" rx="0.75" fill="#4338ca"/>
                  <circle cx="5.5" cy="16" r="1.8" fill="#fbbf24"/>
                  <circle cx="14.5" cy="16" r="1.8" fill="#fbbf24"/>
                  <rect x="1" y="17" width="18" height="1" rx="0.5" fill="white" fillOpacity="0.4"/>
                </svg>
              </div>
              <span className="font-display font-bold text-lg text-white">
                Scale<span className="text-accent-400">Rail</span>
              </span>
            </div>
            <p className="text-sm leading-relaxed text-surface-500">
              A modern, microservices-powered railway ticketing platform built for scale, speed, and reliability.
            </p>
          </div>

          {/* Platform */}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-4">Platform</h4>
            <ul className="space-y-2.5 text-sm">
              <li><a href="/search" className="hover:text-white transition-colors duration-200">Search Trains</a></li>
              <li><a href="/bookings" className="hover:text-white transition-colors duration-200">My Bookings</a></li>
              <li><a href="/login" className="hover:text-white transition-colors duration-200">Sign In</a></li>
            </ul>
          </div>

          {/* Docs */}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-4">Developers</h4>
            <ul className="space-y-2.5 text-sm">
              <li>
                <a
                  href="https://github.com/X-Rachit-X/ScaleRail"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-white transition-colors duration-200 flex items-center gap-1.5"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
                  </svg>
                  GitHub
                </a>
              </li>
              <li><a href="/docs/ARCHITECTURE.md" className="hover:text-white transition-colors duration-200">Architecture</a></li>
              <li><a href="/docs/API.md" className="hover:text-white transition-colors duration-200">API Reference</a></li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="pt-8 border-t border-surface-800 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-surface-600">
          <p>© {year} ScaleRail. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"/>
              All systems operational
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
