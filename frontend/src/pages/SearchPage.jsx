import SearchForm from '../components/search/SearchForm';
import TrainList from '../components/search/TrainList';
import Spinner from '../components/ui/Spinner';
import { useSearchStore } from '../store/search.store';

export default function SearchPage() {
  const { results, isSearching } = useSearchStore();

  const count = results?.count || results?.trains?.length || 0;

  return (
    <div className="section-container py-8">
      <div className="mb-8">
        <h1 className="font-display text-2xl font-bold text-surface-900 mb-1">Search Trains</h1>
        <p className="text-surface-500 text-sm">Search across 500+ stations with smart fuzzy matching</p>
      </div>

      {/* Search Panel */}
      <div className="card mb-8 border-surface-200 shadow-card">
        <SearchForm />
      </div>

      {/* Results */}
      {isSearching ? (
        <div className="flex flex-col items-center justify-center py-24 gap-4">
          <Spinner size="lg" />
          <p className="text-surface-400 text-sm animate-pulse">Searching trains…</p>
        </div>
      ) : results ? (
        <div>
          {/* Results header */}
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary-100 text-primary-700 font-bold text-sm">
                {count}
              </span>
              <p className="text-surface-600 text-sm">
                train{count !== 1 ? 's' : ''} found
                {results.from?.resolved && (
                  <span className="text-surface-900 font-medium"> from {results.from.resolved}</span>
                )}
                {results.to?.resolved && (
                  <span className="text-surface-900 font-medium"> to {results.to.resolved}</span>
                )}
                {results.date && results.date !== 'any' && (
                  <span> on <span className="text-surface-900 font-medium">{results.date}</span></span>
                )}
              </p>
            </div>
          </div>
          <TrainList trains={results.trains} />
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-surface-100 flex items-center justify-center mb-4 text-surface-400">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <circle cx="14" cy="14" r="9" stroke="currentColor" strokeWidth="2"/>
              <path d="M21 21l6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </div>
          <h3 className="font-display font-semibold text-surface-700 mb-1">Start your search</h3>
          <p className="text-surface-400 text-sm">Enter origin and destination to find available trains</p>
        </div>
      )}
    </div>
  );
}
