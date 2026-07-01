export default function EmptyState({ title = 'Nothing here', message = '', icon }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-16 h-16 rounded-2xl bg-surface-100 flex items-center justify-center mb-5 text-surface-400">
        {icon || (
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <rect x="4" y="8" width="24" height="20" rx="3" stroke="currentColor" strokeWidth="2"/>
            <path d="M10 4v4M22 4v4M4 14h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <path d="M11 20h10M13 24h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" opacity="0.5"/>
          </svg>
        )}
      </div>
      <h3 className="font-display font-semibold text-surface-700 text-lg mb-1.5">{title}</h3>
      {message && <p className="text-surface-400 text-sm max-w-xs">{message}</p>}
    </div>
  );
}
