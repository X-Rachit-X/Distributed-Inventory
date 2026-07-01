# ScaleRail

<div align="center">

![ScaleRail Banner](https://img.shields.io/badge/ScaleRail-Railway%20Booking%20Platform-6366f1?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMCAyMCIgZmlsbD0id2hpdGUiPjxyZWN0IHg9IjIiIHk9IjciIHdpZHRoPSIxNiIgaGVpZ2h0PSI4IiByeD0iMi41Ii8+PC9zdmc+)

**A production-grade, microservices-based railway ticketing platform.**  
Fast fuzzy search · Real-time seat locking · Kafka-driven booking saga · Razorpay payments

[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1?style=flat-square&logo=postgresql)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-Stack-DC382D?style=flat-square&logo=redis)](https://redis.io)
[![Kafka](https://img.shields.io/badge/Apache%20Kafka-7.5-231F20?style=flat-square&logo=apachekafka)](https://kafka.apache.org)
[![Elasticsearch](https://img.shields.io/badge/Elasticsearch-8.12-005571?style=flat-square&logo=elasticsearch)](https://elastic.co)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=flat-square&logo=docker)](https://docker.com)
[![Razorpay](https://img.shields.io/badge/Razorpay-Payments-0C2451?style=flat-square)](https://razorpay.com)

</div>

---

## ✨ Features

| Feature | Details |
|---|---|
| 🔍 **Fuzzy Train Search** | Full-text Elasticsearch search across 500+ stations with typo tolerance |
| 💺 **Real-time Seat Locking** | Redis-based 10-minute seat holds preventing double bookings |
| 🚂 **Segment Booking** | Book partial routes — any origin→destination on a multi-stop train |
| 💳 **Razorpay Payments** | Secure checkout with signature verification and automated refunds |
| 📨 **Async Notifications** | Email confirmations via Kafka-driven notification service |
| 🔄 **Booking Saga** | Distributed saga pattern across booking, inventory, and payment services |
| 🔑 **JWT + Refresh Tokens** | Stateless auth with secure HTTP-only refresh token cookies |
| 📊 **Admin Panel** | Manage stations, trains, routes, and schedules |

---

## 🏗️ Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                        React Frontend (Vite)                         │
│                    Port 5173 · Tailwind CSS · Zustand                │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ HTTP / REST
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                           API Gateway                               │
│               Port 3000 · Express · JWT Auth · Rate Limit           │
│      /users/* → user-svc  /bookings/* → booking-svc                │
│      /search/*→search-svc /inventory/*→inventory-svc               │
│      /payments/*→payment-svc  /admin/*→admin-svc                   │
└──────┬──────────┬──────────┬──────────┬─────────────────────────────┘
       │          │          │          │
       ▼          ▼          ▼          ▼
  ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
  │  User   │ │Booking │ │Search  │ │Inventory │
  │ Service │ │Service │ │Service │ │ Service  │
  │ :3001   │ │ :3002  │ │ :3003  │ │  :3004   │
  └────┬────┘ └────┬───┘ └───┬────┘ └────┬─────┘
       │           │          │            │
  ┌────▼────┐ ┌────▼───┐ ┌───▼────┐ ┌────▼─────┐
  │Postgres │ │Postgres│ │Elastic │ │ Postgres │
  │ (users) │ │(bookng)│ │ Search │ │(invntry) │
  └─────────┘ └────────┘ └────────┘ └──────────┘

  ┌────────────────────────────────────────────────────┐
  │                 Apache Kafka                        │
  │    booking.created · payment.completed              │
  │    inventory.seats_held · booking.confirmed         │
  │    booking.cancelled · notification.*               │
  └────────────┬────────────────────┬──────────────────┘
               │                    │
          ┌────▼────┐         ┌──────▼──────┐
          │ Payment │         │Notification │
          │ Service │         │   Service   │
          │  :3005  │         │    :3006    │
          └─────────┘         └─────────────┘
               │
          ┌────▼────┐
          │Postgres │
          │(payment)│
          └─────────┘
```

Full architecture documentation: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)

---

## 🚀 Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop) (with Compose)
- [Node.js 18+](https://nodejs.org)

### 1. Clone the repository

```bash
git clone https://github.com/X-Rachit-X/ScaleRail.git
cd ScaleRail
```

### 2. Start infrastructure services

```bash
docker compose up -d
```

This starts: PostgreSQL · Redis · Kafka · Zookeeper · Elasticsearch · Kibana · pgAdmin · kafka-ui

> Wait ~30 seconds for all services to be healthy.

### 3. Configure each service

Each microservice needs a `.env` file. Copy the examples:

```bash
for dir in user-service booking-service payment-service inventory-service search-service notification-service admin-service api-gateway; do
  cp $dir/.env.example $dir/.env
done
```

Edit each `.env` with your actual secrets (see [Environment Variables](#environment-variables)).

### 4. Install dependencies & run each service

```bash
# Run each in a separate terminal:
cd user-service && npm install && npm run dev
cd booking-service && npm install && npm run dev
cd payment-service && npm install && npm run dev
cd inventory-service && npm install && npm run dev
cd search-service && npm install && npm run dev
cd notification-service && npm install && npm run dev
cd admin-service && npm install && npm run dev
cd api-gateway && npm install && npm run dev
```

### 5. Start the frontend

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) 🎉

---

## 🌐 Service Ports

| Service | Port | Purpose |
|---|---|---|
| Frontend | 5173 | React dev server |
| API Gateway | 3000 | Single entry point |
| User Service | 3001 | Auth, users |
| Booking Service | 3002 | Bookings, cancellations |
| Search Service | 3003 | Train search (Elasticsearch) |
| Inventory Service | 3004 | Seat management |
| Payment Service | 3005 | Razorpay, payments |
| Notification Service | 3006 | Email notifications |
| Admin Service | 3007 | Admin CRUD operations |
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Cache / seat locks |
| Redis UI | 8001 | Redis Insight |
| Kafka | 9093 | Message broker (host) |
| Kafka UI | 8080 | Kafka management |
| Elasticsearch | 9200 | Search index |
| Kibana | 5601 | ES dashboard |
| pgAdmin | 8081 | DB management |

---

## ⚙️ Environment Variables

### API Gateway (`.env`)
```env
PORT=3000
USER_SERVICE_URL=http://localhost:3001
BOOKING_SERVICE_URL=http://localhost:3002
SEARCH_SERVICE_URL=http://localhost:3003
INVENTORY_SERVICE_URL=http://localhost:3004
PAYMENT_SERVICE_URL=http://localhost:3005
ADMIN_SERVICE_URL=http://localhost:3007
INTERNAL_API_SECRET=your-internal-secret
JWT_SECRET=your-jwt-secret
```

### User Service
```env
PORT=3001
DATABASE_URL=postgresql://admin:scalerailpass@localhost:5432/users
JWT_SECRET=your-jwt-secret
REFRESH_TOKEN_SECRET=your-refresh-secret
REDIS_URL=redis://:scalerailpass@localhost:6379
KAFKA_BROKERS=localhost:9093
```

### Payment Service
```env
PORT=3005
DATABASE_URL=postgresql://admin:scalerailpass@localhost:5432/payments
RAZORPAY_KEY_ID=your-razorpay-key
RAZORPAY_KEY_SECRET=your-razorpay-secret
RAZORPAY_WEBHOOK_SECRET=your-webhook-secret
KAFKA_BROKERS=localhost:9093
```

### Frontend (`.env`)
```env
VITE_API_BASE_URL=http://localhost:3000/api
```

---

## 📖 API Reference

See [`docs/API.md`](./docs/API.md) for the complete REST API reference.

### Key endpoints (via Gateway at `:3000`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/users/auth/register/send-otp` | Start registration with OTP |
| `POST` | `/api/users/auth/register/verify-otp` | Verify OTP & create account |
| `POST` | `/api/users/auth/login` | Log in, get JWT + refresh cookie |
| `POST` | `/api/users/auth/logout` | Log out, clear cookies |
| `GET` | `/api/users/auth/me` | Get current user profile |
| `GET` | `/api/search/trains` | Search trains (fuzzy) |
| `GET` | `/api/inventory/:scheduleId/seats` | Get seat list for a schedule |
| `GET` | `/api/inventory/:scheduleId/availability` | Get seat availability counts |
| `POST` | `/api/bookings` | Create a booking + payment order |
| `POST` | `/api/bookings/:id/payment/verify` | Verify Razorpay payment |
| `GET` | `/api/bookings` | List user's bookings |
| `GET` | `/api/bookings/:id` | Get booking details |
| `DELETE` | `/api/bookings/:id` | Cancel a booking |

---

## 🧑‍💻 Tech Stack

### Backend
- **Runtime**: Node.js 18
- **Framework**: Express.js
- **ORM**: Prisma
- **Database**: PostgreSQL 15 (per-service isolation)
- **Cache / Locks**: Redis Stack
- **Message Broker**: Apache Kafka (Confluent)
- **Search**: Elasticsearch 8.12
- **Payments**: Razorpay SDK
- **Auth**: JWT + HTTP-only Refresh Cookies

### Frontend
- **Framework**: React 18 + Vite 6
- **Styling**: Tailwind CSS v3
- **State**: Zustand
- **Forms**: React Hook Form
- **HTTP**: Axios (with auto refresh-token interceptor)
- **Routing**: React Router v6

### Infrastructure
- Docker Compose (local development)
- pgAdmin · Kafka UI · Redis Insight · Kibana

---

## 📁 Project Structure

```
scalerail/
├── api-gateway/          # Single API entry point
├── user-service/         # Auth, registration, OTP, JWT
├── booking-service/      # Booking lifecycle, idempotency
├── payment-service/      # Razorpay integration
├── inventory-service/    # Seat management, Redis locking
├── search-service/       # Elasticsearch train search
├── notification-service/ # Email via Kafka consumer
├── admin-service/        # CRUD for stations/trains/routes
├── shared/               # Shared constants, Kafka topics, helpers
├── frontend/             # React + Vite + Tailwind UI
└── docker-compose.yml    # Infrastructure
```

---

## 📚 Documentation

- [Architecture](./docs/ARCHITECTURE.md) — Full system design, data flow, and diagrams
- [API Reference](./docs/API.md) — Complete REST endpoint documentation

---

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Commit your changes: `git commit -m "feat: add your feature"`
4. Push: `git push origin feat/your-feature`
5. Open a Pull Request

---

## 📝 License

MIT — see [LICENSE](./LICENSE) for details.

---

<div align="center">
  Built with ❤️ by Rachit &nbsp;·&nbsp; 
  <a href="https://github.com/X-Rachit-X/ScaleRail">GitHub</a>
</div>
