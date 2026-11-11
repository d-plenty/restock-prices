// Woolworths: the category list and category pages its own website asks for (public, no sign-in).
import { readSize } from '../lib/size.mjs';

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
