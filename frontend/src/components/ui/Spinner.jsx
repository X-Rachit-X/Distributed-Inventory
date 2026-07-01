export default function Spinner({ size = 'md', light = false }) {
  const sizes = {
    sm: 'w-4 h-4 border-[1.5px]',
    md: 'w-6 h-6 border-2',
    lg: 'w-10 h-10 border-[3px]',
    xl: 'w-14 h-14 border-4',
  };

  const colorClass = light
    ? 'border-white/30 border-t-white'
    : 'border-primary-200 border-t-primary-600';

  return (
    <div
      role="status"
      aria-label="Loading"
      className={`${sizes[size]} ${colorClass} rounded-full animate-spin`}
    />
  );
}
