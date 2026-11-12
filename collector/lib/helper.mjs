// The price helper's inbox (Restock 0.9.11). A spare Android phone running Restock as a "price helper"
// searches Coles and Woolworths through the week and sends what it found here: product facts and
// shelf prices only. They wait in /data/inbox/<shop>.ndjson and are folded into that shop's prices at
// the next run (or `node collect.mjs inbox`), then published with the rest.
//
// Helper uploads need HELPER_KEY ("Authorization: Bearer <HELPER_KEY>"). The same port takes feedback
// (lib/feedback.mjs) and, from 0.9.14, the prices every Restock phone sends back (lib/share.mjs).
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { readSize } from './size.mjs';
import { feedbackHandler } from './feedback.mjs';
import { shareHandler } from './share.mjs';

export const HELPER_SHOPS = ['coles', 'woolworths'];
const MAX_BODY = 8 * 1024 * 1024;
const MAX_PER_POST = 5000;

const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 100_000 ? Math.round(v * 100) / 100 : undefined);

/** One product as the phone sent it, checked and tidied, or undefined. `today`: YYYY-MM-DD. */
export function cleanProduct(chain, p, today) {
  if (!p || typeof p !== 'object') return undefined;
  const spid = str(p.store_product_id, 40);
  const name = str(p.name, 200);
  const price = num(p.price?.price);
  const day = typeof p.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.day) ? p.day : undefined;
  if (!spid || !/^[\w.-]+$/.test(spid) || !name || !price || !day) return undefined;
  // From the last fortnight, and not from the future (a day's grace for time zones).
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  if (!(age >= -1 && age <= 14)) return undefined;
  const size = str(p.size, 60);
  const was = num(p.price?.was_price);
  const image = str(p.image_url, 300);
  return {
    id: `${chain}:${spid}`,
    chain,
    store_product_id: spid,
    name,
    brand: str(p.brand, 80),
    size,
    barcode: /^\d{8,14}$/.test(String(p.barcode ?? '')) ? String(p.barcode) : undefined,
    image_url: image && /^https:\/\//.test(image) ? image : undefined,
    ...readSize(size, name),
    day: day > today ? today : day,
    price: {
      price,
      was_price: was && was > price ? was : undefined,
      is_special: p.price?.is_special === true,
      member_only: p.price?.member_only === true,
      promo: str(p.price?.promo, 120),
    },
  };
}

/** What's waiting for a shop: the products, each with its day. */
export function readInbox(dataDir, shop) {
  const file = join(dataDir, 'inbox', `${shop}.ndjson`);
  if (!existsSync(file)) return { products: [], done: () => {} };
  // Moved aside first, so anything the phone sends meanwhile waits for the next fold.
  const taking = `${file}.${Date.now()}.taking`;
  renameSync(file, taking);
  const products = [];
  for (const line of readFileSync(taking, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      products.push(JSON.parse(line));
    } catch {
      // a line cut short (the disk filled, say): skipped
    }
  }
  return { products, done: () => rmSync(taking, { force: true }) };
}

export function waiting(dataDir, shop) {
  const file = join(dataDir, 'inbox', `${shop}.ndjson`);
  return existsSync(file) ? statSync(file).size : 0;
}

/** Starts the collector's address: the helper phone, phones' prices and feedback. Returns the server. */
export function startHelper({
  dataDir,
  key = process.env.HELPER_KEY,
  port = Number(process.env.HELPER_PORT || 8790),
  today,
  log = console.log,
  feedbackPassword = process.env.FEEDBACK_PASSWORD,
}) {
  // 0.9.13: the same address takes feedback from the app (lib/feedback.mjs), with or without a helper phone.
  const feedback = feedbackHandler({ dataDir, password: feedbackPassword, log });
  // 0.9.14: Send prices back, from every Restock phone that has it on.
  const share = shareHandler({ dataDir, log, today });
  const want = key ? Buffer.from(`Bearer ${key}`) : undefined;
  const allowed = (req) => {
    if (!want) return false;
    const got = Buffer.from(String(req.headers.authorization ?? ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/feedback' || path.startsWith('/feedback/')) {
      if (feedback(req, res, path)) return;
      return reply(res, 404, { error: 'not here' });
    }
    if (path.startsWith('/share/')) {
      if (share(req, res, path)) return;
      return reply(res, 404, { error: 'not here' });
    }
    if (!path.startsWith('/helper/')) return reply(res, 404, { error: 'not here' });
    if (!allowed(req)) return reply(res, 401, { error: 'wrong key' });
    if (req.method === 'GET' && path === '/helper/status')
      return reply(res, 200, { ok: true, shops: HELPER_SHOPS, waiting: Object.fromEntries(HELPER_SHOPS.map((s) => [s, waiting(dataDir, s)])) });
    if (req.method !== 'POST' || path !== '/helper/prices') return reply(res, 404, { error: 'not here' });
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reply(res, 413, { error: 'too big' });
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch {
        return reply(res, 400, { error: 'not JSON' });
      }
      const chain = body?.chain;
      if (body?.format !== 'restock-helper' || !HELPER_SHOPS.includes(chain) || !Array.isArray(body.products) || body.products.length > MAX_PER_POST)
        return reply(res, 400, { error: 'not a price helper upload' });
      const day = today();
      const kept = body.products.map((p) => cleanProduct(chain, p, day)).filter(Boolean);
      if (kept.length) {
        mkdirSync(join(dataDir, 'inbox'), { recursive: true });
        appendFileSync(join(dataDir, 'inbox', `${chain}.ndjson`), kept.map((p) => JSON.stringify(p)).join('\n') + '\n');
      }
      log(`helper: ${kept.length} ${chain} prices from the price helper phone${kept.length < body.products.length ? ` (${body.products.length - kept.length} skipped)` : ''}`);
      reply(res, 200, { ok: true, kept: kept.length });
    });
  });
  server.listen(port, () => log(`port ${port}: ${key ? 'price helper uploads, ' : ''}prices from phones, feedback${feedbackPassword ? ' and its inbox' : ' (set FEEDBACK_PASSWORD to read the inbox)'}`));
  return server;
}
