// Coles: the same public page data Coles' own website loads (Next.js "_next/data" pages), the way
// the open-source hotprices-au project reads Coles. No sign-in and no branch: Coles' online prices.
import { readSize } from '../lib/size.mjs';

const SITE = 'https://www.coles.com.au';
const IMG = 'https://productimages.coles.com.au/productimages';

export function buildIdOf(html) {
  const m = String(html).match(/"buildId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : undefined;
}

export async function setup(http) {
  const home = await http.get(`${SITE}/`, { headers: { Accept: 'text/html' } });
  const build = buildIdOf(home.text);
  if (!build) throw new Error("coles: couldn't find the site's build number (the page may have changed)");
  const r = await http.get(`${SITE}/_next/data/${build}/en/browse.json`, { headers: { Accept: 'application/json' } });
  const j = r.json();
  const groups = j?.pageProps?.allProductCategories?.catalogGroupView ?? [];
  const cats = groups
    .filter((g) => g?.seoToken && (g.level === undefined || g.level === 1) && !/specials|down-down|bonus|liquor|tobacco/i.test(g.seoToken))
    .map((g) => ({ slug: g.seoToken, name: g.name }));
  return { build, cats };
}

export function parsePage(j, cat) {
  const res = j?.pageProps?.searchResults;
  const out = [];
  for (const p of res?.results ?? []) {
    const product = parseProduct(p, cat);
    if (product) out.push(product);
  }
  return { products: out, total: Number(res?.noOfResults ?? 0), pageSize: Number(res?.pageSize ?? 48) || 48 };
}

export function parseProduct(p, cat) {
  if (!p || (p._type && p._type !== 'PRODUCT') || !p.id || typeof p.pricing?.now !== 'number') return undefined;
  const id = String(p.id);
  const pr = p.pricing;
  const name = String(p.name ?? '').trim();
  const size = p.size ? String(p.size) : undefined;
  const img = p.imageUris?.[0]?.uri;
  return {
    id: `coles:${id}`,
    chain: 'coles',
    store_product_id: id,
    name: p.brand && !name.toLowerCase().startsWith(String(p.brand).toLowerCase()) ? `${p.brand} ${name}` : name,
    brand: p.brand || undefined,
    size,
    barcode: /^\d{8,14}$/.test(String(p.gtin ?? p.barcode ?? '')) ? String(p.gtin ?? p.barcode) : undefined,
    image_url: img ? `${IMG}${img.startsWith('/') ? '' : '/'}${img}` : undefined,
    ...readSize(size, name),
    price: {
      price: pr.now,
      was_price: typeof pr.was === 'number' && pr.was > pr.now ? pr.was : undefined,
      is_special: !!(pr.promotionType || pr.specialType || (typeof pr.was === 'number' && pr.was > pr.now)),
      member_only: /flybuys|member/i.test(String(pr.promotionType ?? '')),
      promo: pr.offerDescription || pr.multiBuyPromotion?.reward || undefined,
    },
    details: {
      category: cat?.name ?? p.merchandiseHeir?.category,
      unit_price: pr.comparable || undefined,
      url: `${SITE}/product/${id}`,
    },
  };
}

export async function* collect(http, log) {
  const { build, cats } = await setup(http);
  log(`coles: ${cats.length} categories`);
  for (const cat of cats) {
    for (let page = 1; page < 400; page++) {
      const r = await http.get(`${SITE}/_next/data/${build}/en/browse/${encodeURIComponent(cat.slug)}.json?page=${page}&slug=${encodeURIComponent(cat.slug)}`, {
        headers: { Accept: 'application/json' },
      });
      const { products, total, pageSize } = parsePage(r.json(), cat);
      yield products;
      if (!products.length || page * pageSize >= total) break;
    }
  }
}
