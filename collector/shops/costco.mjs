// Costco: the product search Costco's own website uses (SAP Commerce, site "australia"). Online
// prices, which include delivery. Costco's terms ask people not to collect its listings with
// automated tools: this shop is OFF unless SHOPS includes "costco" in compose.yaml.
import { readSize } from '../lib/size.mjs';

const SITE = 'https://www.costco.com.au';
const PAGE = 100;

export const pageUrl = (page) =>
  `${SITE}/rest/v2/australia/products/search?query=${encodeURIComponent(':relevance')}&fields=FULL&pageSize=${PAGE}&currentPage=${page}&lang=en_AU&curr=AUD`;

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function parseProduct(o) {
  const id = str(o?.code);
  const name = str(o?.name)?.replace(/<[^>]+>/g, '');
  const price = typeof o?.price?.value === 'number' ? Math.round(o.price.value * 100) / 100 : undefined;
  if (!id || !name || !price) return undefined;
  const img = (o.images ?? []).find((x) => x?.url)?.url;
  const was = typeof o.priceRange?.maxPrice?.value === 'number' && o.priceRange.maxPrice.value > price ? o.priceRange.maxPrice.value : undefined;
  const cats = (o.categories ?? []).map((c) => c?.name).filter(Boolean);
  return {
    id: `costco:${id}`,
    chain: 'costco',
    store_product_id: id,
    name,
    brand: str(o.manufacturer),
    size: undefined,
    barcode: /^\d{8,14}$/.test(String(o.ean ?? o.gtin ?? '')) ? String(o.ean ?? o.gtin) : undefined,
    image_url: img ? (img.startsWith('http') ? img : `${SITE}${img}`) : undefined,
    ...readSize(name),
    price: { price, was_price: was, is_special: !!(o.potentialPromotions?.length || was), member_only: false, promo: str(o.potentialPromotions?.[0]?.description) },
    details: { category: cats[cats.length - 1], unit_price: undefined, url: str(o.url) ? `${SITE}${o.url}` : `${SITE}/p/${id}`, online_price_includes_delivery: true },
  };
}

export function parsePage(j) {
  const out = [];
  for (const o of j?.products ?? []) {
    const p = parseProduct(o);
    if (p) out.push(p);
  }
  return { products: out, pages: Number(j?.pagination?.totalPages ?? 0) };
}

export async function* collect(http, log) {
  await http.get(`${SITE}/`, { headers: { Accept: 'text/html' } });
  let pages = 1;
  for (let page = 0; page < Math.min(pages, 300); page++) {
    const r = await http.get(pageUrl(page), { headers: { Accept: 'application/json' } });
    const got = parsePage(r.json());
    if (page === 0) {
      pages = got.pages || 1;
      log(`costco: ${pages} pages`);
    }
    yield got.products;
    if (!got.products.length) break;
  }
}
