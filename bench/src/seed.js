#!/usr/bin/env node
'use strict';

/**
 * Seed reproducible inventory.
 *
 * Deterministic from a seed, so a benchmark run on one commit is comparable to
 * a run on another. Every generated event, coach and seat comes from the same
 * PRNG sequence; nothing uses `Math.random` or the wall clock for content.
 *
 *   node bench/src/seed.js --trains 5 --seats 72 --stops 8
 */

require('../../services/inventory-engine/src/config/env');

const { createPool } = require('@tessera/shared/src/db/pool');
const { recordCapacity } = require('../../services/inventory-engine/src/engine/ledger');

const STATIONS = [
     ['NDLS', 'New Delhi'],
     ['CNB', 'Kanpur Central'],
     ['ALD', 'Prayagraj Junction'],
     ['MGS', 'Pandit Deen Dayal Upadhyaya'],
     ['GAYA', 'Gaya Junction'],
     ['DHN', 'Dhanbad Junction'],
     ['ASN', 'Asansol Junction'],
     ['HWH', 'Howrah Junction'],
     ['KGP', 'Kharagpur Junction'],
     ['BBS', 'Bhubaneswar'],
];

const TRAIN_NAMES = [
     ['12301', 'Howrah Rajdhani'],
     ['12259', 'Sealdah Duronto'],
     ['12313', 'Sealdah Rajdhani'],
     ['12381', 'Poorva Express'],
     ['12303', 'Poorva Express (via Patna)'],
     ['12817', 'Akal Takht Express'],
     ['22811', 'Bhubaneswar Rajdhani'],
];

const CLASSES = [
     { code: '1A', label: 'First AC', priceCents: 480_000, perCoach: 18, coaches: 1 },
     { code: '2A', label: 'Second AC', priceCents: 285_000, perCoach: 46, coaches: 1 },
     { code: '3A', label: 'Third AC', priceCents: 196_000, perCoach: 64, coaches: 2 },
     { code: 'SL', label: 'Sleeper', priceCents: 75_000, perCoach: 72, coaches: 2 },
];

function mulberry32(seed) {
     let a = seed >>> 0;
     return () => {
          a = (a + 0x6d2b79f5) | 0;
          let t = Math.imul(a ^ (a >>> 15), 1 | a);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
     };
}

function parseArgs() {
     const args = { trains: 4, stops: 8, days: 3, seed: 42 };
     const argv = process.argv.slice(2);
     for (let i = 0; i < argv.length; i += 2) {
          const key = argv[i].replace(/^--/, '');
          if (key in args) args[key] = Number(argv[i + 1]);
     }
     return args;
}

async function main() {
     const args = parseArgs();
     const rng = mulberry32(args.seed);

     const pool = createPool({
          connectionString:
               process.env.INVENTORY_DATABASE_URL || 'postgresql://tessera:tessera@localhost:5432/inventory',
          name: 'seed',
          max: 4,
          statementTimeoutMs: 120_000,
     });

     console.log(`Seeding ${args.trains} trains × ${args.days} days, ${args.stops} stops, seed ${args.seed}`);

     let eventCount = 0;
     let resourceCount = 0;

     for (let t = 0; t < args.trains; t++) {
          const [number, name] = TRAIN_NAMES[t % TRAIN_NAMES.length];
          const stops = STATIONS.slice(0, args.stops);

          for (let d = 0; d < args.days; d++) {
               // Dates are derived from today so the data is always in the
               // future, but the CONTENT is fully determined by the seed.
               const departure = new Date();
               departure.setUTCHours(6 + (t % 12), 0, 0, 0);
               departure.setUTCDate(departure.getUTCDate() + d + 1);

               const externalRef = `train-${number}-${departure.toISOString().slice(0, 10)}`;

               await pool.withTransaction(async (client) => {
                    const { rows: existing } = await client.query(
                         `SELECT id FROM inventory_events WHERE external_ref = $1`,
                         [externalRef]
                    );
                    if (existing.length > 0) return;

                    const { rows: eventRows } = await client.query(
                         `INSERT INTO inventory_events
                                 (external_ref, domain, name, starts_at, span_kind, span_max, metadata)
                          VALUES ($1, 'RAIL', $2, $3, 'SEGMENT', $4, $5)
                          RETURNING id`,
                         [
                              externalRef,
                              `${number} ${name}`,
                              departure.toISOString(),
                              // span_max is the number of stops: a journey is a
                              // range over stop indices, so the last valid span
                              // upper bound equals the final stop's index.
                              stops.length - 1,
                              JSON.stringify({ trainNumber: number, trainName: name }),
                         ]
                    );
                    const eventId = eventRows[0].id;
                    eventCount += 1;

                    // The span axis: which stop is which index.
                    for (let s = 0; s < stops.length; s++) {
                         const [code, label] = stops[s];
                         await client.query(
                              `INSERT INTO span_points (event_id, position, ref, label, code)
                               VALUES ($1, $2, $3, $4, $5)`,
                              [eventId, s, `stn-${code}`, label, code]
                         );
                    }

                    const resourceIds = [];

                    for (const cls of CLASSES) {
                         for (let c = 0; c < cls.coaches; c++) {
                              const coachCode = `${cls.code}-${c + 1}`;
                              const cols = 8;
                              const rowsInCoach = Math.ceil(cls.perCoach / cols);

                              const { rows: groupRows } = await client.query(
                                   `INSERT INTO resource_groups (event_id, code, kind, class, row_count, col_count)
                                    VALUES ($1, $2, 'COACH', $3, $4, $5) RETURNING id`,
                                   [eventId, coachCode, cls.code, rowsInCoach, cols]
                              );
                              const groupId = groupRows[0].id;

                              // Build the whole coach in one statement. Seat by
                              // seat would be ~300 round trips per train.
                              const values = [];
                              const params = [eventId, groupId, cls.code];
                              let p = 4;
                              for (let seat = 0; seat < cls.perCoach; seat++) {
                                   const rowIdx = Math.floor(seat / cols);
                                   const colIdx = seat % cols;
                                   // Slight deterministic price variation, so
                                   // "cheapest available" is a real question.
                                   const price = Math.round(cls.priceCents * (0.95 + rng() * 0.1));
                                   values.push(`($1, $2, $${p}, $3, $${p + 1}, $${p + 2}, $${p + 3})`);
                                   params.push(`${coachCode}-${String(seat + 1).padStart(2, '0')}`, rowIdx, colIdx, price);
                                   p += 4;
                              }

                              const { rows: seatRows } = await client.query(
                                   `INSERT INTO inventory_resources
                                           (event_id, group_id, code, class, row_idx, col_idx, base_price_cents)
                                    VALUES ${values.join(', ')}
                                    RETURNING id`,
                                   params
                              );
                              resourceIds.push(...seatRows.map((r) => r.id));
                              resourceCount += seatRows.length;
                         }
                     }

                    // Quantity inventory: meals have no individual identity.
                    // Bucket count > 1 spreads the hot counter.
                    const { rows: poolRows } = await client.query(
                         `INSERT INTO inventory_pools (event_id, code, capacity, bucket_count, price_cents)
                          VALUES ($1, 'MEAL', $2, 4, 25000) RETURNING id`,
                         [eventId, 200]
                    );
                    for (let b = 0; b < 4; b++) {
                         await client.query(
                              `INSERT INTO pool_buckets (pool_id, bucket, capacity) VALUES ($1, $2, 50)`,
                              [poolRows[0].id, b]
                         );
                    }

                    // Opening balance. Without it the ledger cannot be folded
                    // and every seat reports drift.
                    await recordCapacity(client, eventId, resourceIds, {
                         actor: 'system:seed',
                         reason: 'inventory created',
                    });
               });
          }
     }

     const { rows } = await pool.query(
          `SELECT count(DISTINCT e.id)::int AS events, count(r.id)::int AS resources
             FROM inventory_events e LEFT JOIN inventory_resources r ON r.event_id = e.id`
     );

     console.log(`Created ${eventCount} new events, ${resourceCount} new seats`);
     console.log(`Database now holds ${rows[0].events} events and ${rows[0].resources} seats`);

     const { rows: sample } = await pool.query(
          `SELECT external_ref, name, starts_at FROM inventory_events ORDER BY starts_at LIMIT 5`
     );
     console.log('\nSample events:');
     for (const e of sample) {
          console.log(`  ${e.external_ref.padEnd(34)} ${e.name}`);
     }

     await pool.end();
}

main().catch((err) => {
     console.error(err);
     process.exit(1);
});
