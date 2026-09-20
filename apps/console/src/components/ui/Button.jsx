import Spinner from './Spinner';

const VARIANTS = {
  primary:   'btn-primary',
  secondary: 'btn-secondary',
  danger:    'btn-danger',
  accent:    'btn-accent',
  ghost:     'btn-ghost',
};

export default function Button({
  children,
  variant = 'primary',
  loading = false,
  className = '',
  type = 'button',
  disabled,
  onClick,
  id,
}) {
  const base = VARIANTS[variant] || VARIANTS.primary;

  return (
    <button
      id={id}
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={`${base} ${className}`}
    >
      {loading ? (
        <>
          <Spinner size="sm" light />
          <span>Loading…</span>
        </>
      ) : children}
    </button>
  );
}
