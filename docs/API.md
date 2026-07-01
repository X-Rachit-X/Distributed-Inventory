# ScaleRail — REST API Reference

All endpoints are served through the **API Gateway** at `http://localhost:3000`.

## Authentication

Most endpoints require a valid JWT access token:
```
Authorization: Bearer <accessToken>
```

Tokens are obtained via the login endpoint. On expiry (15 min), the Axios client automatically calls `/api/users/auth/refresh` using the HTTP-only refresh cookie.

---

## User Service  `/api/users`

### Auth

#### `POST /api/users/auth/register/send-otp`
Start email registration. Sends a 6-digit OTP to the provided email.

**Body**:
```json
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "password": "string"
}
```

**Response** `200`:
```json
{ "message": "OTP sent to email" }
```

---

#### `POST /api/users/auth/register/verify-otp`
Verify OTP and create account.

**Body**:
```json
{ "otp": "123456" }
```
> OTP is stored in session/Redis from the send-otp call.

**Response** `201`:
```json
{ "message": "Account created. Please log in." }
```

---

#### `POST /api/users/auth/login`
Authenticate user. Returns access token in body, refresh token as HTTP-only cookie.

**Body**:
```json
{
  "email": "user@example.com",
  "password": "yourpassword"
}
```

**Response** `200`:
```json
{
  "accessToken": "eyJhbGci...",
  "loggedInUser": {
    "id": "uuid",
    "firstName": "John",
    "lastName": "Doe",
    "email": "user@example.com"
  }
}
```

---

#### `POST /api/users/auth/refresh`
Rotate refresh token and issue new access token.

> Requires `refreshToken` cookie (set automatically by login).

**Response** `200`:
```json
{ "accessToken": "eyJhbGci..." }
```

---

#### `POST /api/users/auth/logout`
Revoke refresh token and clear cookie.

**Response** `200`:
```json
{ "message": "Logged out" }
```

---

#### `GET /api/users/auth/me`
Get the currently authenticated user's profile.

🔐 **Auth required**

**Response** `200`:
```json
{
  "id": "uuid",
  "firstName": "John",
  "lastName": "Doe",
  "email": "user@example.com",
  "isVerified": true
}
```

---

## Search Service  `/api/search`

#### `GET /api/search/trains`
Search trains using fuzzy Elasticsearch matching.

**Query params**:

| Param | Type | Required | Description |
|---|---|---|---|
| `from` | string | ✅ | Origin station name or code |
| `to` | string | ✅ | Destination station name or code |
| `date` | string (YYYY-MM-DD) | ❌ | Travel date; omit for any date |

**Response** `200`:
```json
{
  "count": 3,
  "from": { "query": "DEL", "resolved": "New Delhi" },
  "to":   { "query": "MUM", "resolved": "Mumbai Central" },
  "date": "2025-01-15",
  "trains": [
    {
      "trainId": "uuid",
      "trainName": "Rajdhani Express",
      "trainNumber": "12301",
      "from": {
        "name": "New Delhi",
        "code": "NDLS",
        "departure": "16:00",
        "sequenceNumber": 1,
        "stationId": "uuid"
      },
      "to": {
        "name": "Mumbai Central",
        "code": "MMCT",
        "arrival": "08:00",
        "sequenceNumber": 5,
        "stationId": "uuid"
      },
      "schedule": {
        "scheduleId": "uuid",
        "departureDate": "2025-01-15",
        "status": "SCHEDULED"
      },
      "seatSummary": {
        "SLEEPER": 120,
        "AC_3_TIER": 60,
        "AC_2_TIER": 30,
        "AC_FIRST": 10,
        "total": 220
      }
    }
  ]
}
```

---

## Inventory Service  `/api/inventory`

#### `GET /api/inventory/:scheduleId/availability`
Get seat availability counts for a schedule.

🔐 **Auth required**

**Response** `200`:
```json
{
  "trainId": "uuid",
  "trainName": "Rajdhani Express",
  "trainNumber": "12301",
  "scheduleId": "uuid",
  "departureDate": "2025-01-15",
  "totalSeats": 220,
  "available": 185,
  "locked": 5,
  "booked": 30
}
```

---

#### `GET /api/inventory/:scheduleId/seats`
Get detailed seat list for a schedule. Supports segment filtering.

🔐 **Auth required**

**Query params**:

| Param | Type | Description |
|---|---|---|
| `fromSeq` | integer | Origin sequence number (segment booking) |
| `toSeq` | integer | Destination sequence number (segment booking) |

**Response** `200`:
```json
{
  "seats": [
    {
      "seatId": "uuid",
      "seatNumber": 1,
      "seatType": "SLEEPER",
      "price": 45000,
      "status": "AVAILABLE",
      "segmentStatus": "AVAILABLE"
    }
  ]
}
```

> Prices are in **paise** (₹1 = 100 paise).

---

## Booking Service  `/api/bookings`

#### `POST /api/bookings`
Create a new booking. Locks seats and creates a Razorpay payment order.

🔐 **Auth required**

**Body**:
```json
{
  "scheduleId": "uuid",
  "seatIds": ["uuid1", "uuid2"],
  "passengers": [
    { "name": "John Doe", "age": 30, "gender": "MALE" },
    { "name": "Jane Doe", "age": 28, "gender": "FEMALE" }
  ],
  "idempotencyKey": "client-generated-uuid",
  "fromStationId": "uuid",
  "toStationId": "uuid",
  "fromSeq": 1,
  "toSeq": 5
}
```

**Response** `201`:
```json
{
  "bookingId": "uuid",
  "status": "PAYMENT_PENDING",
  "paymentOrder": {
    "gatewayOrderId": "order_xxx",
    "keyId": "rzp_test_xxx",
    "amount": 90000,
    "currency": "INR"
  }
}
```

---

#### `POST /api/bookings/:bookingId/payment/verify`
Verify Razorpay payment after user completes checkout.

🔐 **Auth required**

**Body**:
```json
{
  "razorpayPaymentId": "pay_xxx",
  "razorpaySignature": "hmac_signature"
}
```

**Response** `200`:
```json
{ "message": "Payment verified. Booking confirmation in progress." }
```

---

#### `GET /api/bookings`
List the authenticated user's bookings.

🔐 **Auth required**

**Query params**:

| Param | Type | Description |
|---|---|---|
| `status` | string | Filter by status (CONFIRMED, CANCELLED, etc.) |
| `page` | integer | Page number (default: 1) |
| `limit` | integer | Results per page (default: 10) |

**Response** `200`:
```json
{
  "bookings": [
    {
      "id": "uuid",
      "trainName": "Rajdhani Express",
      "trainNumber": "12301",
      "status": "CONFIRMED",
      "departureDate": "2025-01-15",
      "totalAmount": 90000,
      "seatCount": 2,
      "createdAt": "2025-01-10T12:00:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalPages": 3,
    "total": 25
  }
}
```

---

#### `GET /api/bookings/:bookingId`
Get full details of a single booking.

🔐 **Auth required**

**Response** `200`:
```json
{
  "id": "uuid",
  "trainName": "Rajdhani Express",
  "trainNumber": "12301",
  "status": "CONFIRMED",
  "departureDate": "2025-01-15",
  "totalAmount": 90000,
  "seatCount": 2,
  "createdAt": "2025-01-10T12:00:00Z",
  "seats": [
    { "seatId": "uuid", "seatNumber": 15, "seatType": "SLEEPER", "price": 45000 }
  ],
  "passengers": [
    { "id": "uuid", "name": "John Doe", "age": 30, "gender": "MALE" }
  ]
}
```

---

#### `DELETE /api/bookings/:bookingId`
Cancel a booking. Initiates refund if payment was captured.

🔐 **Auth required**

**Response** `200`:
```json
{ "message": "Booking cancelled. Refund will be processed within 5-7 business days." }
```

**Error** `400`:
```json
{ "message": "Booking cannot be cancelled in FAILED state" }
```

---

## Admin Service  `/api/admin`

> All admin endpoints require authentication. Role-based access control can be added as a future enhancement.

#### `POST /api/admin/stations` — Create station
#### `GET /api/admin/stations` — List stations
#### `PUT /api/admin/stations/:id` — Update station

#### `POST /api/admin/trains` — Create train
#### `GET /api/admin/trains` — List trains
#### `PUT /api/admin/trains/:id` — Update train

#### `POST /api/admin/routes` — Create route with stations
#### `GET /api/admin/routes` — List routes
#### `POST /api/admin/routes/:id/stations` — Add station to route

#### `POST /api/admin/schedules` — Create schedule
#### `GET /api/admin/schedules` — List schedules
#### `PUT /api/admin/schedules/:id` — Update schedule status

---

## Error Format

All error responses follow:
```json
{
  "message": "Human-readable error description",
  "code": "MACHINE_READABLE_CODE",
  "status": 400
}
```

Common status codes:
| Code | Meaning |
|---|---|
| 400 | Bad request / validation error |
| 401 | Unauthenticated (no/invalid token) |
| 403 | Forbidden |
| 404 | Resource not found |
| 409 | Conflict (idempotency key reuse, seat already booked) |
| 422 | Unprocessable entity |
| 500 | Internal server error |
