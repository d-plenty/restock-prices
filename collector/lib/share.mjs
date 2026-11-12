// Restock 0.9.14: "Send prices back". Every Restock phone with it on (the default) sends the shelf
// prices it reads from Coles, Woolworths, Aldi and Costco (searches and price checks) here:
//   POST /share/prices  { format: "restock-share", v: 1, install, chain, products: [ … ] }
// Each product is the same shape as a price helper phone's (lib/helper.mjs cleanProduct). Only what
// the shop's own website said: never prices typed in by hand, and nothing about the person.
//
// There's no key: a free, open-source app can't keep one secret. So it's checked instead:
//  - limits per phone (its random install number) and per internet address, kept in memory only;
//  - every product is tidied and checked like the helper phone's (sensible prices, the last fortnight);
//  - at the nightly fold (collect.mjs), a phone never replaces the collector's or the helper phone's
//    own reading for a day, never renames a product the collector already knows, and a price far
//    from the last known one, or a product the collector hasn't seen, waits until a second phone
//    sends the same price (for up to 14 days).
// The internet address is never written down. The install number is kept only as a short hash,
// to tell two phones apart.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { cleanProduct } from './helper.mjs';
import { put } from './store.mjs';

export const SHARE_SHOPS = ['coles', 'woolworths', 'aldi', 'costco'];
const MAX_BODY = 4 * 1024 * 1024;
const MAX_PER_POST = 2000;
const POSTS_PER_PHONE_A_DAY = 200;
const PRODUCTS_PER_PHONE_A_DAY = 20_000;
const POSTS_PER_ADDRESS_A_DAY = 600;
const HOLD_DAYS = 14;
/** A phone's price outside this many times the last known price waits for a second phone. */
const LOW = 0.35;
const HIGH = 2.5;

const hash = (s) => createHash('sha256').update(`restock-share:${s}`).digest('hex').slice(0, 12);

export function shareHandler({ dataDir, log = console.log, now = () => new Date(), today }) {
  const dir = join(dataDir, 'phones');
  const counts = new Map(); // "<day> <kind>:<who>" → how many today
  const bump = (k, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  let logged = { day: '', posts: 0, kept: 0 };

  return function handle(req, res, path) {
    if (path !== '/share/prices') return false;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      return true;
    }
    if (req.method !== 'POST') {
      json(res, 405, { error: 'POST only' });
      return true;
    }
    const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        json(res, 413, { error: 'too big: send fewer at a time' });
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        return json(res, 400, { error: 'not JSON' });
      }
      const chain = body?.chain;
      const install = typeof body?.install === 'string' && /^[\w-]{6,64}$/.test(body.install) ? body.install : undefined;
      if (body?.format !== 'restock-share' || !SHARE_SHOPS.includes(chain) || !install || !Array.isArray(body.products) || body.products.length > MAX_PER_POST)
        return json(res, 400, { error: 'not a Restock price share' });
      const day = now().toISOString().slice(0, 10);
      const phone = hash(install);
      if ((counts.get(`${day} p:${phone}`) ?? 0) >= POSTS_PER_PHONE_A_DAY || (counts.get(`${day} a:${who}`) ?? 0) >= POSTS_PER_ADDRESS_A_DAY)
        return json(res, 429, { error: 'That’s a lot for one day. It will send again tomorrow.' });
      if ((counts.get(`${day} n:${phone}`) ?? 0) + body.products.length > PRODUCTS_PER_PHONE_A_DAY) return json(res, 429, { error: 'That’s a lot for one day. It will send again tomorrow.' });
      const t = today();
      const kept = body.products.map((p) => cleanProduct(chain, p, t)).filter(Boolean);
      bump(`${day} p:${phone}`);
      bump(`${day} a:${who}`);
      bump(`${day} n:${phone}`, kept.length);
      if (counts.size > 20_000) for (const k of counts.keys()) if (!k.startsWith(day)) counts.delete(k);
      if (kept.length) {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `${chain}.ndjson`), kept.map((p) => JSON.stringify({ ...p, from: phone })).join('\n') + '\n');
      }
      // 0.10.0: a line for every post, with the day's running total (a phone sends a few times a day).
      if (logged.day !== day) logged = { day, posts: 0, kept: 0 };
      logged.posts++;
      logged.kept += kept.length;
      log(`share: ${kept.length} ${chain} prices from a phone (${logged.posts} posts, ${logged.kept} prices today)`);
      json(res, 200, { ok: true, kept: kept.length });
    });
    return true;
  };
}

/** What the phones sent for a shop, and the ones still waiting for a second phone. */
function readPhones(dataDir, shop) {
  const dir = join(dataDir, 'phones');
  const file = join(dir, `${shop}.ndjson`);
  const heldFile = join(dir, `${shop}-held.ndjson`);
  const lines = [];
  let taking;
  if (existsSync(file)) {
    taking = `${file}.${Date.now()}.taking`;
    renameSync(file, taking);
    lines.push(...readFileSync(taking, 'utf8').split('\n'));
  }
  if (existsSync(heldFile)) lines.push(...readFileSync(heldFile, 'utf8').split('\n'));
  const items = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    try {
      items.push(JSON.parse(l));
    } catch {
      // a line cut short: skipped
    }
  }
  return {
    items,
    done: (held) => {
      mkdirSync(dir, { recursive: true });
      if (held.length) writeFileSync(heldFile, held.map((p) => JSON.stringify(p)).join('\n') + '\n');
      else rmSync(heldFile, { force: true });
      if (taking) rmSync(taking, { force: true });
    },
  };
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const cents = (x) => Math.round(x * 100);

/** The last price known before (or on) a day. */
function lastBefore(prices, day) {
  let last;
  for (const x of prices ?? []) if (x.date <= day) last = x;
  return last;
}

/**
 * Folds what the phones sent into a shop's state. Returns { count, changed, held, phones }.
 * `today`: YYYY-MM-DD. The collector's and helper phone's readings always win on their day.
 */
export function foldPhones(state, shop, dataDir, today) {
  if (!SHARE_SHOPS.includes(shop)) return { count: 0, changed: 0, held: 0, phones: 0 };
  const { items, done } = readPhones(dataDir, shop);
  state.products ??= {};
  // The same product, day and price from different phones agree with each other.
  const agree = new Map(); // "id day cents" → Set of phones
  for (const p of items) {
    const k = `${p.id} ${p.day} ${cents(p.price?.price ?? 0)}`;
    (agree.get(k) ?? agree.set(k, new Set()).get(k)).add(p.from ?? '?');
  }
  const held = [];
  const used = new Set();
  const phones = new Set();
  let changed = 0;
  let count = 0;
  // Oldest day first, so each reading is judged against the one before it.
  for (const p of [...items].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    if (!p?.id || !p.day || !(p.price?.price > 0)) continue;
    const k = `${p.id} ${p.day} ${cents(p.price.price)}`;
    if (used.has(k)) {
      if (p.from) phones.add(p.from); // the same reading from another phone
      continue;
    }
    const twoPhones = (agree.get(k)?.size ?? 0) >= 2;
    const cur = state.products[p.id];
    const last = cur ? lastBefore(cur.prices, p.day) : undefined;
    const odd = !cur || (last && (p.price.price < last.price * LOW || p.price.price > last.price * HIGH));
    if (odd && !twoPhones) {
      if (daysBetween(p.day, today) <= HOLD_DAYS) held.push(p);
      continue;
    }
    used.add(k);
    count++;
    if (p.from) phones.add(p.from);
    const prod = (state.products[p.id] ??= { prices: [] });
    // A product the collector already knows keeps its own name, brand, size and picture.
    for (const f of ['chain', 'store_product_id', 'name', 'brand', 'size', 'image_url', 'qty', 'qty_unit']) {
      if (p[f] !== undefined && p[f] !== null && p[f] !== '' && (prod[f] === undefined || prod[f] === null || prod[f] === '')) prod[f] = p[f];
    }
    if (p.barcode && !prod.barcode) prod.barcode = p.barcode;
    if (!prod.seen || p.day > prod.seen) prod.seen = p.day;
    const point = { date: p.day, price: p.price.price };
    if (p.price.was_price && p.price.was_price > p.price.price) point.was_price = p.price.was_price;
    if (p.price.is_special) point.is_special = true;
    if (p.price.member_only) point.member_only = true;
    if (p.price.promo) point.promo = String(p.price.promo).slice(0, 120);
    if (put(prod.prices, point, { keep: true })) changed++;
  }
  done(held);
  return { count, changed, held: held.length, phones: phones.size };
}

/** How much is waiting from phones for a shop (bytes), for the log. */
export function phonesWaiting(dataDir, shop) {
  const file = join(dataDir, 'phones', `${shop}.ndjson`);
  return existsSync(file) ? statSync(file).size : 0;
}
