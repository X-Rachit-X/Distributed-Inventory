import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useBookingStore } from '../store/booking.store';
import BookingSummary from '../components/booking/BookingSummary';
import PassengerList from '../components/booking/PassengerList';
import PaymentButton from '../components/booking/PaymentButton';

export default function BookingPage() {
  const navigate = useNavigate();
  const selectedTrain = useBookingStore((s) => s.selectedTrain);
  const selectedSeats = useBookingStore((s) => s.selectedSeats);
  const scheduleId = useBookingStore((s) => s.scheduleId);

  const seats = useMemo(() => Array.from(selectedSeats.values()), [selectedSeats]);
  const seatIds = useMemo(() => seats.map((s) => s.seatId), [seats]);
  const totalPrice = useMemo(() => seats.reduce((sum, s) => sum + (s.price || 0), 0), [seats]);

  const { register, handleSubmit, formState: { errors, isValid }, getValues } = useForm({
    mode: 'onChange',
  });

  useEffect(() => {
    if (seats.length === 0) navigate('/search');
  }, [seats.length, navigate]);

  if (seats.length === 0) return null;

  return (
    <div className="section-container py-8">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <h1 className="font-display text-2xl font-bold text-surface-900 mb-1">Complete Your Booking</h1>
          <p className="text-surface-500 text-sm">Review your seats and fill in passenger details</p>
        </div>

        <BookingSummary train={selectedTrain} seats={seats} totalPrice={totalPrice} />

        <div className="card mb-6">
          <h3 className="font-display font-semibold text-surface-900 mb-5">Passenger Details</h3>
          <form id="passenger-form" onSubmit={handleSubmit(() => {})}>
            <PassengerList seats={seats} register={register} errors={errors} />
          </form>
        </div>

        <PaymentButton
          passengers={getValues('passengers') || []}
          scheduleId={scheduleId}
          seatIds={seatIds}
          disabled={!isValid}
        />
      </div>
    </div>
  );
}
