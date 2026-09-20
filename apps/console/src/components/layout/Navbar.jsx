import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useAuthStore } from '../../store/auth.store';

export default function Navbar() {
  const { user, isAuthenticated, logout } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path) => location.pathname === path;

  const navLinkClass = (path) =>
    `relative px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200
     after:absolute after:bottom-0 after:left-1/2 after:-translate-x-1/2 after:h-0.5
     after:rounded-full after:transition-all after:duration-200
     ${isActive(path)
       ? 'text-white after:w-3/4 after:bg-accent-400'
       : 'text-primary-200 hover:text-white hover:bg-white/10 after:w-0 hover:after:w-0'
     }`;

  return (
    <nav
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-primary-950/95 backdrop-blur-lg shadow-navbar border-b border-white/5'
          : 'bg-primary-950'
      }`}
    >
      <div className="section-container">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2.5 group">
            <div className="relative flex items-center justify-center w-9 h-9 rounded-xl bg-gradient-to-br from-primary-500 to-accent-500 shadow-glow group-hover:shadow-glow-accent transition-shadow duration-300">
              {/* Train SVG icon */}
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="2" y="7" width="16" height="8" rx="2.5" fill="white" fillOpacity="0.95"/>
                <rect x="4" y="8.5" width="3" height="3" rx="0.75" fill="#4338ca"/>
                <rect x="8.5" y="8.5" width="3" height="3" rx="0.75" fill="#4338ca"/>
                <circle cx="5.5" cy="16" r="1.8" fill="#fbbf24"/>
                <circle cx="14.5" cy="16" r="1.8" fill="#fbbf24"/>
                <rect x="1" y="17" width="18" height="1" rx="0.5" fill="white" fillOpacity="0.4"/>
                <rect x="1" y="6.5" width="4" height="0.8" rx="0.4" fill="white" fillOpacity="0.5"/>
              </svg>
            </div>
            <div className="leading-none">
              <span className="font-display font-bold text-xl text-white tracking-tight">
                Scale<span className="text-accent-400">Rail</span>
              </span>
            </div>
          </Link>

          {/* Desktop nav links */}
          <div className="hidden sm:flex items-center gap-1">
            <Link to="/search" className={navLinkClass('/search')}>Search</Link>

            {isAuthenticated ? (
              <>
                <Link to="/bookings" className={navLinkClass('/bookings')}>My Bookings</Link>
                <Link to="/admin" className={navLinkClass('/admin')}>Admin</Link>

                <div className="flex items-center gap-2 ml-3 pl-3 border-l border-white/10">
                  <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary-700 ring-1 ring-white/20">
                    <span className="text-xs font-bold text-white">
                      {user?.firstName?.[0]?.toUpperCase()}
                    </span>
                  </div>
                  <span className="hidden md:inline text-sm text-primary-200 font-medium">
                    {user?.firstName}
                  </span>
                  <button
                    onClick={handleLogout}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-primary-200 hover:text-white hover:bg-white/10 transition-all duration-200"
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <Link
                to="/login"
                className="ml-2 btn-accent text-sm py-2 px-4 shadow-sm"
              >
                Get Started
              </Link>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className="sm:hidden flex flex-col gap-1.5 p-2 rounded-lg hover:bg-white/10 transition-colors"
            onClick={() => setMenuOpen(!menuOpen)}
            aria-label="Toggle menu"
          >
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 ${menuOpen ? 'rotate-45 translate-y-2' : ''}`}/>
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 ${menuOpen ? 'opacity-0' : ''}`}/>
            <span className={`block h-0.5 w-5 bg-white rounded transition-all duration-200 ${menuOpen ? '-rotate-45 -translate-y-2' : ''}`}/>
          </button>
        </div>

        {/* Mobile menu */}
        {menuOpen && (
          <div className="sm:hidden border-t border-white/10 py-3 space-y-1 animate-fade-in">
            <Link to="/search" className="block px-3 py-2.5 rounded-lg text-sm font-medium text-primary-200 hover:text-white hover:bg-white/10 transition-colors">
              Search Trains
            </Link>
            {isAuthenticated ? (
              <>
                <Link to="/bookings" className="block px-3 py-2.5 rounded-lg text-sm font-medium text-primary-200 hover:text-white hover:bg-white/10 transition-colors">
                  My Bookings
                </Link>
                <Link to="/admin" className="block px-3 py-2.5 rounded-lg text-sm font-medium text-primary-200 hover:text-white hover:bg-white/10 transition-colors">
                  Admin
                </Link>
                <div className="pt-2 border-t border-white/10">
                  <div className="px-3 py-1 text-xs text-primary-400">Signed in as {user?.firstName}</div>
                  <button
                    onClick={handleLogout}
                    className="block w-full text-left px-3 py-2.5 rounded-lg text-sm font-medium text-red-400 hover:bg-red-400/10 transition-colors"
                  >
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <Link to="/login" className="block px-3 py-2.5 rounded-lg text-sm font-medium text-accent-400 hover:bg-white/10 transition-colors">
                Get Started →
              </Link>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
