// Each shop's price history, kept small: a price is only written down when it changes (price,
// was-price, special, member-only or promo), plus the day it was last seen. From it:
//   latest/<shop>.json.gz          what phones download (Restock's import format), the last year
//   latest/<shop>-details.json.gz  extra facts per product (category, unit price, link)
//   history/<shop>/<year>.json.gz  prices older than a year, so latest/ stays small

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

export const KEEP_DAYS = 365;
export const DROP_UNSEEN_DAYS = 90;

export function readGz(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'));
}

export function writeGz(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // mtime 0 so the same content gives the same bytes (no empty git commits).
  writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }));
  renameSync(tmp, path);
}

const same = (a, b) =>
  a.price === b.price && (a.was_price ?? null) === (b.was_price ?? null) && !!a.is_special === !!b.is_special && !!a.member_only === !!b.member_only && (a.promo ?? null) === (b.promo ?? null);

/**
 * Fold one run's products into the state.
 * @param {{ products: Record<string, any> }} state
 * @param {any[]} found  [{ id, chain, store_product_id, name, brand, size, barcode, image_url, qty, qty_unit, details, price: { price, was_price, is_special, member_only, promo } }]
 * @param {string} day  YYYY-MM-DD
 */
export function fold(state, found, day) {
  state.products ??= {};
  let changed = 0;
  for (const f of found) {
    if (!f?.id || typeof f.price?.price !== 'number' || !(f.price.price > 0)) continue;
    const cur = (state.products[f.id] ??= { prices: [] });
    for (const k of ['chain', 'store_product_id', 'name', 'brand', 'size', 'image_url', 'qty', 'qty_unit']) if (f[k] !== undefined && f[k] !== null && f[k] !== '') cur[k] = f[k];
    if (f.barcode) cur.barcode = f.barcode; // keep a barcode once known
    if (f.details) cur.details = f.details;
    cur.seen = day;
    // From hotprices: the product's own dated prices, oldest first. Each goes in on its own day.
    for (const h of [...(f.history ?? [])].sort((x, y) => (x.date < y.date ? -1 : 1))) {
      if (!(h.price > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(h.date) || h.date > day) continue;
      const last0 = cur.prices[cur.prices.length - 1];
      if (last0 && last0.date > h.date) continue;
      const pt = { date: h.date, price: h.price };
      if (!last0 || !same(last0, pt)) {
        if (last0 && last0.date === h.date) cur.prices[cur.prices.length - 1] = pt;
        else cur.prices.push(pt);
        changed++;
      }
    }
    const point = { date: day, price: f.price.price };
    if (f.price.was_price && f.price.was_price > f.price.price) point.was_price = f.price.was_price;
    if (f.price.is_special) point.is_special = true;
    if (f.price.member_only) point.member_only = true;
    if (f.price.promo) point.promo = String(f.price.promo).slice(0, 120);
    const last = cur.prices[cur.prices.length - 1];
    if (!last || !same(last, point)) {
      if (last && last.date === day) cur.prices[cur.prices.length - 1] = point;
      else cur.prices.push(point);
      changed++;
    }
  }
  return changed;
}

const daysBefore = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

/** Move prices older than a year out to history/, drop products not seen for 90 days from latest/. */
export function split(state, day) {
  const cutoff = daysBefore(day, KEEP_DAYS);
  const unseen = daysBefore(day, DROP_UNSEEN_DAYS);
  const old = {}; // year -> id -> points
  for (const [id, p] of Object.entries(state.products ?? {})) {
    const keep = [];
    const gone = [];
    for (const pt of p.prices) (pt.date < cutoff ? gone : keep).push(pt);
    // The newest old point stays too, so "the price before this year" is still known.
    if (gone.length && (!keep.length || keep[0].date > cutoff)) keep.unshift(gone[gone.length - 1]);
    for (const pt of gone) ((old[pt.date.slice(0, 4)] ??= {})[id] ??= []).push(pt);
    p.prices = keep;
    if (p.seen && p.seen < unseen && !p.prices.some((x) => x.date >= unseen)) p.stale = true;
    else delete p.stale;
  }
  return old;
}

/** The import-format file phones download (docs/restock-import.md in Restock). */
export function latestFile(shop, state) {
  const products = [];
  for (const [id, p] of Object.entries(state.products ?? {})) {
    if (p.stale || !p.prices.length) continue;
    const out = { id, chain: shop, store_product_id: p.store_product_id, name: p.name };
    for (const k of ['brand', 'size', 'barcode', 'image_url', 'qty', 'qty_unit']) if (p[k] !== undefined && p[k] !== null && p[k] !== '') out[k] = p[k];
    out.prices = p.prices;
    products.push(out);
  }
  products.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { format: 'restock-export', v: 1, tables: { products } };
}

export function detailsFile(shop, state) {
  const out = {};
  for (const [id, p] of Object.entries(state.products ?? {})) if (!p.stale && p.details) out[id] = p.details;
  return { format: 'restock-details', v: 1, chain: shop, products: out };
}

/** Merge old points into history/<shop>/<year>.json.gz. */
export function writeHistory(root, shop, old) {
  for (const [year, byId] of Object.entries(old)) {
    const path = join(root, 'history', shop, `${year}.json.gz`);
    const cur = readGz(path, { format: 'restock-history', v: 1, chain: shop, year, prices: {} });
    for (const [id, pts] of Object.entries(byId)) {
      const have = new Map((cur.prices[id] ?? []).map((x) => [x.date, x]));
      for (const pt of pts) have.set(pt.date, pt);
      cur.prices[id] = [...have.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    }
    writeGz(path, cur);
  }
}
