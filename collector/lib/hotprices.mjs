// hotprices.org: the open-source tracker (a fork of heisse-preise) that publishes Coles' and
// Woolworths' prices every day, with each product's past prices. Used when a shop's own site turns
// the collector away (Woolworths always does; Coles sometimes does).
import { gunzipSync } from 'node:zlib';
import { readSize } from './size.mjs';

export const HOTPRICES = {
  woolworths: 'https://hotprices.org/data/latest-canonical.woolies.compressed.json.gz',
  coles: 'https://hotprices.org/data/latest-canonical.coles.compressed.json.gz',
};
const LINK = {
  woolworths: (id) => `https://www.woolworths.com.au/shop/productdetails/${id}`,
  coles: (id) => `https://www.coles.com.au/product/${id}`,
};
const IMAGE = {
  coles: (id) => `https://productimages.coles.com.au/productimages/${String(id)[0]}/${id}.jpg`,
};

/** One hotprices item ("canonical" format) as a product carrying its own dated prices. */
export function fromHotprices(chain, it) {
  if (!it || it.id === undefined || it.id === null || !it.name) return undefined;
  const id = String(it.id).replace(/\.0$/, '');
  const hist = (it.priceHistory ?? [])
    .filter((h) => h && typeof h.price === 'number' && h.price > 0 && typeof h.date === 'string')
    .map((h) => ({ date: h.date.slice(0, 10), price: h.price }));
  if (!hist.length) return undefined;
  const newest = [...hist].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
  const unit = String(it.unit ?? '').toLowerCase();
  const qty = typeof it.quantity === 'number' && it.quantity > 0 ? it.quantity : undefined;
  const fromUnit = qty && (unit === 'g' || unit === 'ml') ? { qty, qty_unit: unit } : qty && unit === 'stk' ? { qty, qty_unit: 'ea' } : {};
  return {
    id: `${chain}:${id}`,
    chain,
    store_product_id: id,
    name: String(it.name).trim(),
    image_url: IMAGE[chain]?.(id),
    ...(it.isWeighted ? {} : { ...readSize(it.name), ...fromUnit }),
    price: { price: newest.price },
    history: hist,
    details: { category: it.category || undefined, url: it.url || LINK[chain]?.(id), source: 'hotprices.org' },
  };
}

export async function* fromHotpricesFile(chain, http, log) {
  const res = await (http.fetch ?? fetch)(HOTPRICES[chain], { headers: { 'User-Agent': 'RestockPrices/1.0 (+https://github.com/d-plenty/restock-prices)' } });
  http.requests = (http.requests ?? 0) + 1;
  if (!res.ok) throw new Error(`${chain}: hotprices.org answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const items = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8'));
  log(`${chain}: ${items.length} products from hotprices.org`);
  let batch = [];
  for (const it of items) {
    const p = fromHotprices(chain, it);
    if (p) batch.push(p);
    if (batch.length >= 1000) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}
