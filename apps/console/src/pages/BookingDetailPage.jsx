import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useBookingPolling } from '../hooks/useBookingPolling';
import { bookingApi } from '../api/booking.api';
import { useToast } from '../components/ui/Toast';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Modal from '../components/ui/Modal';
import Spinner from '../components/ui/Spinner';
import BookingStatusPoller from '../components/booking/BookingStatusPoller';
import { formatDate, formatDateTime, formatCurrency, formatSeatType } from '../utils/format';

export default function BookingDetailPage() {
  const { bookingId } = useParams();
  const { booking, loading, error, refresh } = useBookingPolling(bookingId);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const showToast = useToast();

  const handleCancel = async () => {
    setCancelling(true);
    try {
      await bookingApi.cancel(bookingId);
      showToast('Booking cancelled successfully', 'success');
      setShowCancel(false);
      refresh();
    } catch (err) {
      showToast(err.message || 'Failed to cancel', 'error');
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-4">
        <Spinner size="lg" />
        <p className="text-surface-400 text-sm animate-pulse">Loading booking details…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="section-container py-8">
        <div className="max-w-3xl mx-auto">
          <div className="card border-red-100 text-center py-10">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="8" stroke="#dc2626" strokeWidth="1.5"/>
                <path d="M10 6v5M10 13v.5" stroke="#dc2626" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </div>
            <p className="font-semibold text-surface-900 mb-1">Error loading booking</p>
            <p className="text-sm text-surface-500">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!booking) return null;

  const canCancel = ['CONFIRMED', 'PAYMENT_PENDING', 'SEATS_HELD'].includes(booking.status);

  return (
    <div className="section-container py-8">
      <div className="max-w-3xl mx-auto">
        {/* Back link */}
        <Link to="/bookings" className="inline-flex items-center gap-1.5 text-sm text-surface-500 hover:text-surface-700 mb-6 transition-colors">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Back to bookings
        </Link>

        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="font-display text-2xl font-bold text-surface-900">Booking Details</h1>
            <p className="text-surface-400 text-xs font-mono mt-1">{booking.id}</p>
          </div>
          <Badge status={booking.status} />
        </div>

        <BookingStatusPoller status={booking.status} />

        {/* Status banners */}
        {booking.status === 'CONFIRMED' && (
          <div className="flex items-center gap-3 bg-emerald-50 border border-emerald-200 rounded-2xl p-4 mb-6">
            <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M3 9l4 4 8-8" stroke="#059669" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <p className="font-semibold text-emerald-800">Booking Confirmed!</p>
              <p className="text-sm text-emerald-600">Your tickets have been booked successfully.</p>
            </div>
          </div>
        )}

        {booking.status === 'FAILED' && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-2xl p-4 mb-6">
            <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M4 4l10 10M14 4L4 14" stroke="#dc2626" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <div>
              <p className="font-semibold text-red-800">Booking Failed</p>
              {booking.failureReason && <p className="text-sm text-red-600 mt-0.5">{booking.failureReason}</p>}
            </div>
          </div>
        )}

        {/* Train Info */}
        <div className="card mb-4">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h3 className="font-display font-semibold text-primary-700 text-lg">{booking.trainName}</h3>
              <p className="text-xs font-mono text-surface-400 mt-0.5">#{booking.trainNumber}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-surface-400 mb-0.5">Departure</p>
              <p className="font-semibold text-surface-800 text-sm">{formatDate(booking.departureDate)}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 border-t border-surface-100">
            <div>
              <p className="text-xs text-surface-400 mb-1">Booked on</p>
              <p className="text-sm font-medium text-surface-700">{formatDateTime(booking.createdAt)}</p>
            </div>
            <div>
              <p className="text-xs text-surface-400 mb-1">Total Amount</p>
              <p className="text-sm font-bold text-primary-700">{formatCurrency(booking.totalAmount)}</p>
            </div>
            <div>
              <p className="text-xs text-surface-400 mb-1">Seats</p>
              <p className="text-sm font-medium text-surface-700">{booking.seatCount}</p>
            </div>
            <div>
              <p className="text-xs text-surface-400 mb-1">Status</p>
              <Badge status={booking.status} />
            </div>
          </div>
        </div>

        {/* Seats Table */}
        <div className="card mb-4">
          <h3 className="font-semibold text-surface-900 mb-4">Seat Details</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-100">
                  <th className="py-2 text-left text-xs font-semibold text-surface-500 uppercase tracking-wide">Seat #</th>
                  <th className="py-2 text-left text-xs font-semibold text-surface-500 uppercase tracking-wide">Class</th>
                  <th className="py-2 text-right text-xs font-semibold text-surface-500 uppercase tracking-wide">Price</th>
                </tr>
              </thead>
              <tbody>
                {booking.seats?.map((s) => (
                  <tr key={s.seatId} className="border-b border-surface-50">
                    <td className="py-2.5 font-mono text-xs text-surface-700">{s.seatNumber}</td>
                    <td className="py-2.5 text-surface-700">{formatSeatType(s.seatType)}</td>
                    <td className="py-2.5 text-right font-semibold text-primary-700">{formatCurrency(s.price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Passengers */}
        {booking.passengers?.length > 0 && (
          <div className="card mb-6">
            <h3 className="font-semibold text-surface-900 mb-4">Passenger Details</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-100">
                    {['#', 'Name', 'Age', 'Gender'].map((h) => (
                      <th key={h} className="py-2 text-left text-xs font-semibold text-surface-500 uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {booking.passengers.map((p, i) => (
                    <tr key={p.id || i} className="border-b border-surface-50">
                      <td className="py-2.5 text-surface-500">{i + 1}</td>
                      <td className="py-2.5 font-medium text-surface-800">{p.name}</td>
                      <td className="py-2.5 text-surface-600">{p.age}</td>
                      <td className="py-2.5 text-surface-600 capitalize">{p.gender}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {canCancel && (
          <Button variant="danger" onClick={() => setShowCancel(true)} className="w-full">
            Cancel Booking
          </Button>
        )}

        <Modal
          open={showCancel}
          onClose={() => setShowCancel(false)}
          title="Cancel Booking?"
          confirmText="Yes, Cancel Booking"
          onConfirm={handleCancel}
          loading={cancelling}
          danger
        >
          Are you sure you want to cancel this booking? This action cannot be undone.
          {booking.status === 'CONFIRMED' && ' A refund will be initiated to your original payment method.'}
        </Modal>
      </div>
    </div>
  );
}
