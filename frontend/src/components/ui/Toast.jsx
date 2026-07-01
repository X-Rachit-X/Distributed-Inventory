import { useState, useCallback, createContext, useContext } from 'react';

const ToastContext = createContext(null);

export function useToast() {
  return useContext(ToastContext);
}

const TOAST_CONFIG = {
  success: {
    bar: 'bg-emerald-500',
    bg: 'bg-white border border-emerald-100',
    icon: (
      <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2.5 7l3 3 6-6" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
    ),
    text: 'text-surface-900',
  },
  error: {
    bar: 'bg-red-500',
    bg: 'bg-white border border-red-100',
    icon: (
      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center shrink-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 3l8 8M11 3l-8 8" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"/>
        </svg>
      </div>
    ),
    text: 'text-surface-900',
  },
  warning: {
    bar: 'bg-amber-400',
    bg: 'bg-white border border-amber-100',
    icon: (
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 1L13 12H1L7 1z" stroke="#d97706" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M7 5.5v3M7 10v.5" stroke="#d97706" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
    ),
    text: 'text-surface-900',
  },
  info: {
    bar: 'bg-primary-500',
    bg: 'bg-white border border-primary-100',
    icon: (
      <div className="w-8 h-8 rounded-full bg-primary-100 flex items-center justify-center shrink-0">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="#6366f1" strokeWidth="1.5"/>
          <path d="M7 6v4M7 4.5v.5" stroke="#6366f1" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </div>
    ),
    text: 'text-surface-900',
  },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2.5 max-w-sm w-full pr-1">
        {toasts.map((t) => {
          const cfg = TOAST_CONFIG[t.type] || TOAST_CONFIG.info;
          return (
            <div
              key={t.id}
              className={`${cfg.bg} rounded-xl shadow-card-hover flex items-center gap-3 pr-4 overflow-hidden animate-slide-in`}
            >
              {/* Colored left bar */}
              <div className={`w-1 self-stretch rounded-l-xl shrink-0 ${cfg.bar}`} />
              {cfg.icon}
              <span className={`text-sm font-medium py-3 ${cfg.text} flex-1`}>{t.message}</span>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
