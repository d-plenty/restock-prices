// Woolworths. By default from hotprices.org, the open-source tracker that already publishes
// Woolworths' prices every day (WOOLWORTHS_SOURCE=hotprices): one download, no requests to
// Woolworths, and months of past prices straight away. WOOLWORTHS_SOURCE=site reads Woolworths' own
// category pages instead (Woolworths refuses requests that aren't from a browser).
import { gunzipSync } from 'node:zlib';
import { readSize } from '../lib/size.mjs';

export const HOTPRICES = 'https://hotprices.org/data/latest-canonical.woolies.compressed.json.gz';

/** One hotprices item (heisse-preise "canonical" format) as a product with its own dated prices. */
export function fromHotprices(it) {
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
    id: `woolworths:${id}`,
    chain: 'woolworths',
    store_product_id: id,
    name: String(it.name).trim(),
    brand: undefined,
    size: undefined,
    barcode: undefined,
    image_url: undefined,
    ...(it.isWeighted ? {} : { ...readSize(it.name), ...fromUnit }),
    price: { price: newest.price },
    history: hist,
    details: { category: it.category || undefined, url: it.url || `${SITE}/shop/productdetails/${id}`, source: 'hotprices.org' },
  };
}

async function* fromHotpricesFile(http, log) {
  const res = await (http.fetch ?? fetch)(HOTPRICES, { headers: { 'User-Agent': 'RestockPrices/1.0 (+https://github.com/d-plenty/restock-prices)' } });
  http.requests = (http.requests ?? 0) + 1;
  if (!res.ok) throw new Error(`woolworths: hotprices.org answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
  const items = JSON.parse(text);
  log(`woolworths: ${items.length} products from hotprices.org`);
  let batch = [];
  for (const it of items) {
    const p = fromHotprices(it);
    if (p) batch.push(p);
    if (batch.length >= 1000) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length) yield batch;
}

const SITE = 'https://www.woolworths.com.au';
const PAGE = 36;
// Not food or groceries, or the same products again under another name.
const SKIP = /specials|front of store|halloween|christmas|new & trending|lunch box|everyday market|liquor|tobacco/i;

export async function categories(http) {
  await http.get(`${SITE}/`, { headers: { Accept: 'text/html' } }); // the site's session cookies
  const r = await http.get(`${SITE}/apis/ui/PiesCategoriesWithSpecials`, { headers: { Accept: 'application/json' } });
  const j = r.json();
  return (j.Categories ?? [])
    .filter((c) => c.NodeId && c.UrlFriendlyName && !SKIP.test(c.Description ?? ''))
    .map((c) => ({ id: c.NodeId, name: c.Description, slug: c.UrlFriendlyName }));
}

export function pageBody(cat, page) {
  return JSON.stringify({
    categoryId: cat.id,
    pageNumber: page,
    pageSize: PAGE,
    sortType: 'TraderRelevance',
    url: `/shop/browse/${cat.slug}`,
    location: `/shop/browse/${cat.slug}`,
    formatObject: JSON.stringify({ name: cat.name }),
    isSpecial: false,
    isBundle: false,
    isMobile: false,
    filters: [],
    token: '',
    gpBoost: 0,
    isHideUnavailableProducts: false,
    isRegisteredRewardCardPromotion: false,
    enableAdReRanking: false,
    groupEdmVariants: true,
    categoryVersion: 'v2',
  });
}

/** One page of a category: { products, total }. */
export function parsePage(j, cat) {
  const out = [];
  for (const b of j?.Bundles ?? [])
    for (const p of b?.Products ?? []) {
      const product = parseProduct(p, cat);
      if (product) out.push(product);
    }
  return { products: out, total: Number(j?.TotalRecordCount ?? 0) };
}

export function parseProduct(p, cat) {
  if (!p?.Stockcode || typeof p.Price !== 'number') return undefined;
  const id = String(p.Stockcode);
  const name = String(p.DisplayName || p.Name || '').trim();
  const promo = p.IsHalfPrice ? 'Half price' : p.CentreTag?.TagContentText || p.HeaderTag?.Content || undefined;
  return {
    id: `woolworths:${id}`,
    chain: 'woolworths',
    store_product_id: id,
    name,
    brand: p.Brand || undefined,
    size: p.PackageSize || undefined,
    barcode: /^\d{8,14}$/.test(String(p.Barcode ?? '')) ? String(p.Barcode) : undefined,
    image_url: p.MediumImageFile || p.LargeImageFile || undefined,
    ...readSize(p.PackageSize, name),
    price: {
      price: p.Price,
      was_price: typeof p.WasPrice === 'number' && p.WasPrice > p.Price ? p.WasPrice : undefined,
      is_special: !!p.IsOnSpecial,
      member_only: !!(p.IsMemberPrice || p.IsEdrSpecial),
      promo: typeof promo === 'string' ? promo.replace(/<[^>]+>/g, '').trim() || undefined : undefined,
    },
    details: {
      category: cat?.name,
      unit_price: p.CupString || undefined,
      url: `${SITE}/shop/productdetails/${id}`,
    },
  };
}

export async function* collect(http, log) {
  if ((process.env.WOOLWORTHS_SOURCE || 'hotprices') !== 'site') {
    yield* fromHotpricesFile(http, log);
    return;
  }
  const cats = await categories(http);
  log(`woolworths: ${cats.length} categories`);
  for (const cat of cats) {
    for (let page = 1; page < 400; page++) {
      const r = await http.get(`${SITE}/apis/ui/browse/category`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: SITE, Referer: `${SITE}/shop/browse/${cat.slug}` },
        body: pageBody(cat, page),
      });
      const { products, total } = parsePage(r.json(), cat);
      yield products;
      if (!products.length || page * PAGE >= total) break;
    }
  }
}
