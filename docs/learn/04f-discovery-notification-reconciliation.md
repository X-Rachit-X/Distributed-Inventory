# 04f · File by file — discovery, notification, reconciliation

These three services are the **read side** and the **safety net**. None of them can
cause an oversell: discovery is labelled non-authoritative, notification only
writes its own inbox, and reconciliation repairs only reversible inventory problems.

---

## Part 1 — Discovery (port 4006): search

```
discovery/
├── sql/migrations/010_projection.sql      trips, trip_stops (trigram), trip_segments, dirty_events
├── sql/migrations/011_dirty_attempts.sql  poison handling for the refresh queue
├── src/index.js                           search API + cache + Kafka consumer
├── src/projection.js                      refresher: rebuild a train's search rows
└── src/search-index.js                    Elasticsearch client + circuit breaker + Postgres fallback
```

### `010_projection.sql`

| Object | Meaning |
|---|---|
| comment | the flow: event → mark dirty (in the dedupe tx) → refresher re-reads the authority → upsert here + ES; periodic resync. "Events are 'this changed' signals, not state" |
| `pg_trgm` | trigram fuzzy matching ("kanpr" finds Kanpur Central) |
| `trips` | one row per train run, `refreshed_at` |
| `trip_stops` | `(event_id, position)` → code, label, `offset_minutes`; **GIN trigram index on label** |
| `trip_segments` | PK `(event_id, span_from, span_to, class)` → `available`, `total`, `fare_cents`, `tier`, `refreshed_at`. Precomputed, so a search never scans live allocations |
| `dirty_events` | the durable refresh queue: one row per train that needs a refresh |

### `011_dirty_attempts.sql`

Adds `attempts` and `last_error`. The story: deleted test events failed with 404
on every refresh, and because the refresher took the *oldest* rows first, those rows
starved every real refresh. That is a DB-table version of a poison message stalling
a Kafka partition.

### `src/projection.js`

| Method | What |
|---|---|
| `#get(path)` | GET inventory with 8 s timeout; 404 → error with `notFound` |
| `static markDirty(client, eventId, reason)` | `INSERT dirty_events … ON CONFLICT DO UPDATE SET marked_at=now()`, **using the consumer's transaction client** (so the dedupe marker and the dirty mark commit together) |
| `refresh(eventId)` | (1) fetch `segment-availability`, `span-points`, `/v1/events` in parallel. (2) 404, or the event is no longer active → delete from `trips` + clear its ES docs → `{removed:true}`. (3) price every segment with **the shared `fare()`**. (4) stop offsets: `metadata.offsetMinutes` or `position × 150 min`. (5) one tx: upsert `trips`, replace `trip_stops`, replace `trip_segments` (one multi-row insert). (6) build one ES document per (from, to) pair with per-class fields `avail_3A`, `fare_3A`, `tier_3A`…, `depart_at`, `arrive_at`, `travel_date`, `duration_minutes`, `min_fare`. (7) `index.indexTrip(docs)`. (8) `onRefresh` → bump the cache version |
| `tick()` | tx: `SELECT event_id, attempts FROM dirty_events ORDER BY marked_at FOR UPDATE SKIP LOCKED LIMIT 10`; for each: refresh → delete the dirty row. Error → attempts+1 ≥ 5 → drop (resync re-adds it); else `attempts+1, marked_at=now()` (**back of the queue**) |
| `resync()` | mark every active train dirty; delete trips that no longer exist |
| `start({tickMs:1000, resyncMs:60000})` | refresher loop + periodic resync (one runs immediately) |
| `staleness()` | oldest/newest `refreshed_at` + pending count → metric |

💡 **Coalescing**: 300 events for one train in a second → still one `dirty_events`
row → one refresh.

> 🔍 Note: `tick()` keeps its transaction (and the row locks on `dirty_events`) open
> while `refresh()` makes HTTP calls to inventory and Elasticsearch. This is the one
> place the code bends Rule 2 ("no network I/O inside a transaction"). The impact is
> limited (a read-model DB, batches of 10, 8 s / 3 s timeouts), but a stricter
> version would claim with a lease, release the tx, refresh, then delete.

### `src/search-index.js`

| Part | What |
|---|---|
| `ElasticIndex` | plain-HTTP client (3 s timeout); `healthy` flag; **circuit breaker**: `trip(err)` sets `retryAt = now + 10 s`; `available()` = healthy OR past `retryAt`. Fixes the old bug where one cold-start timeout disabled ES forever |
| `init()` | create the index `tessera-trips` if missing: 1 shard, 0 replicas; **dynamic template** maps `avail_*`, `total_*`, `fare_*` to integer; explicit mapping for keyword/text/date fields |
| `indexTrip(docs, eventId)` | `_delete_by_query` for that event, then a `_bulk` NDJSON upload. **No `refresh=true`** (forcing a refresh per write was the old search service's performance problem; the 1 s refresh interval is fine). Failure → `healthy=false`, Postgres stays current |
| `search(q)` | bool query: station clauses (`from`/`to`), train `multi_match` with fuzziness, filters on `travel_date`, depart/arrive time ranges, fare range on `fare_<class>` or `min_fare`, class, `onlyAvailable` → `avail_<class> > 0`; sort by departure; size 50. On error → `trip()` and rethrow |
| `stationClause(side, input)` | `should`: exact code (boost 5) OR fuzzy label match (`prefix_length 1`) → "HWH", "howrah", "howra" all work |
| `searchPostgres(db, q)` | the same search in SQL: join segments + trips + from/to stops; station match = `code = upper(input) OR word_similarity(input, label) > 0.5` (the comment explains why `word_similarity` beats `similarity`: "kanpr" scores 0.67 against its best word vs 0.24 against the whole label); fold per-class rows into one result per (trip, from, to) shaped like ES output; time filters in JS; max 50 |

### `src/index.js`

| Part | What |
|---|---|
| config | port, DB, inventory URL, Kafka, Redis, ES URL, L1 1 s, L2 5 s |
| `CONSUMER_GROUP = 'discovery-projection-v1'` | changing the name would replay history |
| Redis | `enableOfflineQueue: false`; errors swallowed ("L2 is optional") |
| `currentVersion()` / `bumpVersion()` | version from Redis `discovery:version` (falls back to a local counter); bump = local+1, clear L1, `INCR` in Redis |
| `cachedSearch(query)` | key = `discovery:search:<version>:<sha1(query)>` → **L1** hit? → **L2** hit (also fill L1)? → **single-flight** (`inflight` Map, result tagged `COALESCED`) → `runSearch` → fill L1 + L2 with a **jittered TTL** (5 + 0..2 s) |
| `runSearch` | ES if `available()`, on failure fall back to `searchPostgres`; compute the oldest `refreshed_at` → `as_of`, `ageSeconds` (+ metric) |
| `present(doc)` | API shape: one object per result with a `classes[]` array |
| consumer `handle(envelope)` | `handleOnce(envelope, client => Projection.markDirty(client, eventId, type), { projection: true })`: dedupe + **aggregate_seq staleness guard** |
| `GET /v1/search` | validates `date` (YYYY-MM-DD); builds the query (fares in rupees → paise); sets `x-cache`; returns `data, backend, cache, as_of, ageSeconds, authoritative:false` |
| `GET /v1/stations` | autocomplete: prefix/ILIKE/similarity |
| `GET /v1/status` | trips, segments, events consumed, staleness, consumer lag, cache version |
| `POST /admin/rebuild` | internal token → `resync()` |
| `main()` | init ES → start the projection → start the Kafka consumer on `inventory.events` (a failure is logged: "projection will rely on resync") → listen |

---

## Part 2 — Notification (port 4005): exactly one email

### `sql/migrations/010_notifications.sql`

`notifications(customer_id, channel EMAIL/SMS/PUSH, template, subject, body,
reservation_id, source_event_id, status, created_at)` with **`UNIQUE
(source_event_id, template)`**, a second, independent guard against a duplicate
email even if the dedupe marker were bypassed.

### `src/index.js`

| Part | What |
|---|---|
| `CONSUMER_GROUP = 'notification-v1'` | |
| `render(envelope)` | `booking.confirmed` → "Booking confirmed — TSR-…", seats, total in ₹ (formatted `en-IN`) and currency; `booking.cancelled` → cancelled (+ refund text); anything else → `null` (ignored) |
| `handle(envelope)` | `handleOnce(envelope, client => INSERT notifications … ON CONFLICT (source_event_id, template) DO NOTHING; log "notification sent")`. A `DUPLICATE` result is logged: "duplicate delivery absorbed; customer not notified twice" |
| comment on the "send" | a real email call would happen **after** commit, keyed by `source_event_id`, so the email provider can dedupe too |
| `GET /v1/notifications` | the customer's inbox (customer id from the gateway header) |
| `GET /v1/status` | events processed, notifications sent, open dead letters, lag |
| `GET /admin/dead-letters`, `POST /admin/dead-letters/replay` | internal token; replay uses `replayDeadLetters` |
| `main()` | `startConsumer({ topics: ['booking.events'], readerVersion: { 'booking.confirmed': 2 } })`: reads v2, **v1 events are upcast**; other types are read as produced |

> 🔍 Notes: the header comment says it consumes `payment.events` too, but the code
> subscribes only to `booking.events`. And `render()` handles `booking.cancelled`,
> but no service currently *produces* that event (the cancel path in reservation
> doesn't enqueue it). Both are harmless, and good to know.

---

## Part 3 — Reconciliation (port 4004): the auditor

```
reconciliation/
├── sql/migrations/010_reconciliation.sql   runs, issues, repair_log (append-only), scoreboard
├── src/checks/index.js                     the 8 checks
├── src/worker.js                           run → record → maybe repair → close resolved → snapshot
├── src/index.js                            scoreboard, issues, manual actions
└── test/reconciliation.test.js             8 tests
```

### `010_reconciliation.sql`

| Object | Meaning |
|---|---|
| comment | no cross-DB snapshot is atomic, so **grace window + re-check**; repair policy: inventory-only auto, money → recommendation + human |
| `recon_runs` | each pass: checks run, found, repaired, duration |
| `reconciliation_issues` | `kind` (10 kinds listed), `severity`, entity, `expected`/`actual` JSON, `detail`, **`money_involved`** (set by the check, at detection time), `repair_status` (`OPEN, AUTO_REPAIRED, AWAITING_HUMAN, REPAIRED_BY_HUMAN, RESOLVED_ITSELF, IGNORED`), `recommended_action`, **`seen_count`**, first/last seen. `UNIQUE (kind, entity_type, entity_id)` |
| `repair_log` + append-only trigger | every repair, automatic or human |
| `scoreboard_snapshots` + view `scoreboard_current` | counts of open critical issues, duplicates, ledger mismatches, orphaned holds, payments without booking, stuck sagas, last run |

### `src/checks/index.js`

Each check is `{ name, graceSeconds, run({inventory, reservation, payment, graceSeconds}) → issues[] }`.
Three rules: **grace window**, **read-only**, **money is flagged**.

| Check | SQL idea | Severity / money |
|---|---|---|
| `EXPIRED_HOLD_STILL_ALLOCATED` | `allocations WHERE state='HELD' AND expires_at < now() − 120s` | HIGH / no, with `context {holdId, resourceId, eventId}` for the repair |
| `LEDGER_DRIFT` | `SELECT * FROM invariant_ledger_drift` | CRITICAL / no. Not auto-repaired: "we do not know which side is wrong; writing a correcting entry could paper over the bug" |
| `DUPLICATE_BOOKING` | `invariant_duplicate_bookings` | CRITICAL / yes: "escalate immediately" |
| `PAYMENT_WITHOUT_BOOKING` | captured > 300 s ago in the payment DB → collect `reservation_id`s → `SELECT … FROM reservations WHERE id = ANY($1) AND state='CONFIRMED'` in the reservation DB → the difference | CRITICAL / yes. **No cross-database join**: ids are collected and the other DB is queried |
| `CONFIRMED_WITHOUT_PAYMENT` | the reverse direction | CRITICAL / yes |
| `STUCK_SAGA` | non-terminal and not updated for 120 s | HIGH if MANUAL_REVIEW else MEDIUM; money if in PAYMENT_UNKNOWN / MANUAL_REVIEW / REFUND_PENDING |
| `PAYMENT_UNKNOWN_TOO_LONG` | UNKNOWN for > 600 s | CRITICAL / yes |
| `OUTBOX_BACKLOG` | per service: PENDING or DEAD_LETTER older than 120 s | HIGH if dead letters else MEDIUM / no |

### `src/worker.js`

| Method | What |
|---|---|
| `run()` | insert a `recon_runs` row → for each check: run (errors are logged, other checks continue) → `#record` each issue → `#maybeRepair` → `#closeResolved(seenKeys)` → update run stats → `#snapshot()` |
| `#record` | upsert on `(kind, entity_type, entity_id)`: `seen_count+1`, refresh `actual`/`detail`; a `RESOLVED_ITSELF` issue that comes back is re-OPENed |
| `#maybeRepair` | only `OPEN` issues. **Money → `AWAITING_HUMAN`, stop.** `seen_count < 2` → wait for confirmation. No repairer for this kind → AWAITING_HUMAN. Repair success → `AUTO_REPAIRED` + `repair_log`. Failure → `repair_log` FAILED + AWAITING_HUMAN |
| `#repairerFor` | only two repairs exist. `EXPIRED_HOLD_STILL_ALLOCATED`: guarded `UPDATE allocations SET state='EXPIRED' WHERE id=$1 AND state='HELD' AND expires_at < now()` (0 rows → "already moved on"), then ledger `EXPIRED +1`, then close the hold if empty. `STUCK_SAGA`: refuses MANUAL_REVIEW; `UPDATE sagas SET next_run_at=now(), lease cleared WHERE non-terminal`. "Everything financial is absent by design" |
| `#closeResolved` | previously open issues not seen this pass → `RESOLVED_ITSELF` |
| `#snapshot` / `scoreboard()` | write a snapshot; set gauges; `allClear` if every counter is 0 |

### `src/index.js`

- Pools: its own DB (5) + **small read pools** for inventory/reservation/payment
  (max 3 each), so an audit never competes with real traffic. The inventory and
  reservation pools are also given as `repairers`; payments deliberately aren't.
- `GET /v1/scoreboard`: worker counters + inventory `invariant_summary` + outbox
  pending/dead per service + open dead letters + processed-events count. `correct`
  looks at correctness keys only; `allClear` looks at everything ("an outbox backlog
  means events are late, not that inventory is wrong").
- `GET /v1/issues?status=open|all|<state>`, sorted by severity; `GET /v1/runs`.
- `POST /admin/run`: run a pass now.
- `POST /admin/issues/:id/(resolve|ignore|retry)`: **a reason is required**; `retry`
  re-opens with `seen_count=1` and runs a pass; `resolve` → `REPAIRED_BY_HUMAN`;
  `ignore` → `IGNORED`; always writes `repair_log` with the actor (`x-actor`).

### `test/reconciliation.test.js` (8 tests)

Detection: an expired hold still allocated, ledger drift (inventory moved without a
ledger row), captured payment with no confirmed reservation, stalled saga. Policy:
**money issues are never auto-repaired**, an expired hold is repaired only after two
sightings, a self-resolving issue is recorded as `RESOLVED_ITSELF`. Scoreboard:
counters and the all-clear flag.

Next: [04g · Lab, bench, tests, console, deploy →](04g-lab-bench-tests-console-deploy.md)
