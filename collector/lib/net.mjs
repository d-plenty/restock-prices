// Restock 0.10.1: who's asking, for the limits on what one internet address can send. Kept in memory
// only, never written down.
//
// Behind Cloudflare the real address is in CF-Connecting-IP, which Cloudflare sets itself. Otherwise
// it's the last address in X-Forwarded-For (the one your own reverse proxy added): the first one is
// whatever the sender wrote, so anyone could pretend to be a new address each time.

/** The address to count a request against. */
export function clientAddress(req) {
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf && cf.length <= 64) return cf;
  const fwd = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fwd.length) return fwd[fwd.length - 1].slice(0, 64);
  return String(req.socket?.remoteAddress ?? '?');
}

/**
 * Counts per key per day (or per hour), in memory. `bump(key, n)` adds and returns the new count;
 * `get(key)` reads it. Old periods are dropped as it goes.
 */
export function dayCounter({ now = () => new Date(), hourly = false } = {}) {
  const counts = new Map();
  const period = () => now().toISOString().slice(0, hourly ? 13 : 10);
  const key = (k) => `${period()} ${k}`;
  const tidy = () => {
    if (counts.size < 20_000) return;
    const p = period();
    for (const k of counts.keys()) if (!k.startsWith(p)) counts.delete(k);
  };
  return {
    get: (k) => counts.get(key(k)) ?? 0,
    bump: (k, n = 1) => {
      tidy();
      const v = (counts.get(key(k)) ?? 0) + n;
      counts.set(key(k), v);
      return v;
    },
  };
}

/**
 * A form or button on one of this collector's own pages, not from another website. Browsers say so
 * in Sec-Fetch-Site; older ones send Origin. Anything else (a script with no browser) is let through,
 * since it can't carry the browser's saved password without the page's help.
 */
export function sameSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
