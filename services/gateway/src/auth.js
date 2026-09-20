'use strict';

/**
 * Minimal signed tokens (HS256 JWT).
 *
 * Hand-rolled rather than pulled from a library because the project's subject
 * is inventory correctness, and a dependency here would obscure what is
 * actually being verified. The parts that matter are done properly:
 *
 *   - constant-time signature comparison, so an attacker cannot learn how much
 *     of a forged signature matched by timing the response;
 *   - expiry checked on every verification;
 *   - failures return null rather than throwing, so a malformed token is a 401
 *     and never a 500.
 *
 * A production deployment would delegate to an identity provider. Nothing
 * downstream would change: services only need a verified subject.
 */

const crypto = require('node:crypto');

const b64url = (input) => Buffer.from(input).toString('base64url');

function signToken(claims, secret, ttlSeconds) {
     const now = Math.floor(Date.now() / 1000);
     const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
     const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
     const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
     return `${header}.${payload}.${signature}`;
}

function verifyToken(token, secret) {
     if (typeof token !== 'string') return null;
     const parts = token.split('.');
     if (parts.length !== 3) return null;

     const [header, payload, signature] = parts;
     const expected = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');

     const a = Buffer.from(signature);
     const b = Buffer.from(expected);
     if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

     let claims;
     try {
          claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
     } catch {
          return null;
     }

     if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
     return claims;
}

module.exports = { signToken, verifyToken };
