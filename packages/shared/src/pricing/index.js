'use strict';

/**
 * Fare rules.
 *
 * Deliberately simple — the spec is explicit that this is not an airline revenue
 * management engine. Three factors, each with a stated reason:
 *
 *   1. BASE × SEAT CLASS. The resource's base price already encodes the class
 *      (1A costs more than SL), so the class multiplier lives in the seed data,
 *      where an operator would set it.
 *
 *   2. DISTANCE. A passenger travelling 2 of 7 stops should not pay the full
 *      end-to-end fare. The fare scales with the share of the route travelled,
 *      with a floor so very short hops still cover the cost of issuing a ticket.
 *
 *   3. DEMAND TIER. As a class fills, the fare steps up. Tiers rather than a
 *      continuous curve so that the price a customer sees is stable for a while
 *      and explainable on a receipt ("High demand: +25%").
 *
 * This module is the ONLY place fares are computed. The pricing service uses it
 * to quote, the discovery service uses it for the indicative "from ₹X" in search
 * results, and the reservation service stores the quoted value on the hold. A
 * client-supplied price is never trusted.
 */

const MIN_SPAN_SHARE = 0.3;

/** Demand tiers, keyed by how full the class is (0..1). Ordered by threshold. */
const TIERS = [
     { upTo: 0.5, multiplier: 1.0, code: 'STANDARD', label: 'Standard fare' },
     { upTo: 0.8, multiplier: 1.1, code: 'FILLING', label: 'Filling up' },
     { upTo: 0.95, multiplier: 1.25, code: 'HIGH_DEMAND', label: 'High demand' },
     { upTo: Infinity, multiplier: 1.5, code: 'LAST_SEATS', label: 'Last few seats' },
];

function demandTier(available, total) {
     if (!total || total <= 0) return TIERS[0];
     const occupancy = 1 - available / total;
     return TIERS.find((t) => occupancy < t.upTo) ?? TIERS[TIERS.length - 1];
}

/**
 * Fare for one resource over one span.
 *
 * @param {object} args
 * @param {number} args.basePriceCents  End-to-end fare for this seat.
 * @param {number} args.spanFrom
 * @param {number} args.spanTo
 * @param {number} args.spanMax         Length of the whole route.
 * @param {number} args.classAvailable  Seats of this class still free for the span.
 * @param {number} args.classTotal
 * @returns {{ fareCents: number, tier: object, spanShare: number }}
 */
function fare({ basePriceCents, spanFrom, spanTo, spanMax, classAvailable, classTotal }) {
     const spanShare = Math.max(MIN_SPAN_SHARE, (spanTo - spanFrom) / Math.max(1, spanMax));
     const tier = demandTier(classAvailable, classTotal);
     const raw = Number(basePriceCents) * spanShare * tier.multiplier;
     // Round to whole rupees: fares ending in paise read as a bug to customers.
     const fareCents = Math.max(100, Math.round(raw / 100) * 100);
     return { fareCents, tier, spanShare: +spanShare.toFixed(3) };
}

module.exports = { fare, demandTier, TIERS, MIN_SPAN_SHARE };
