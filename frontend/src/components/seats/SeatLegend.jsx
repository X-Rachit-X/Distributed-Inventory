const items = [
  { label: 'Available', color: 'bg-emerald-50 border-emerald-300', dot: 'bg-emerald-400' },
  { label: 'Selected',  color: 'bg-primary-600 border-primary-700', dot: 'bg-primary-400' },
  { label: 'Locked',    color: 'bg-amber-50 border-amber-300',  dot: 'bg-amber-400' },
  { label: 'Booked',    color: 'bg-red-50 border-red-200',    dot: 'bg-red-400' },
];

export default function SeatLegend() {
  return (
    <div className="flex flex-wrap gap-4">
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-2">
          <span className={`w-5 h-5 rounded-lg border-2 ${item.color}`} />
          <span className="text-xs text-surface-500 font-medium">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
