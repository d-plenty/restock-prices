// Restock 0.10.1: who's asking, for the limits on what one internet address can send. Kept in memory
// only, never written down.
//
// Behind Cloudflare the real address is in CF-Connecting-IP, which Cloudflare sets itself. Otherwise
// it's the last address in X-Forwarded-For (the one your own reverse proxy added): the first one is
// whatever the sender wrote, so anyone could pretend to be a new address each time.

/**
 * 0.10.5: the request came through a proxy on this machine or network (Cloudflare's tunnel, Dockge's
 * reverse proxy), so its address headers can be believed. Straight from the internet they can't:
 * anyone could send a made-up CF-Connecting-IP with each request and look like a new phone every
 * time, getting round the limits and the "second phone agrees" check on shared prices.
 * TRUST_PROXY=always believes them whatever the address (only if nothing else can reach the port);
 * TRUST_PROXY=never never does.
 */
export function viaProxy(remote, trust = process.env.TRUST_PROXY) {
  if (trust === 'always') return true;
  if (trust === 'never') return false;
  const a = String(remote ?? '').replace(/^::ffff:/i, '');
  return (
    a === '::1' ||
    /^127\./.test(a) ||
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a) ||
    /^f[cd][0-9a-f]{2}:/i.test(a) ||
    /^fe80:/i.test(a)
  );
}

/** The address to count a request against. */
export function clientAddress(req) {
  const remote = String(req.socket?.remoteAddress ?? '?');
  if (!viaProxy(remote)) return remote;
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf && cf.length <= 64) return cf;
  const fwd = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fwd.length) return fwd[fwd.length - 1].slice(0, 64);
  return remote;
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
