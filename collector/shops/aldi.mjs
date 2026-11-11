// Aldi: the public product API Aldi's own website uses (api.aldi.com.au). Aldi has one price for
// every store, so this is the shelf price too.
import { readSize } from '../lib/size.mjs';

const API = 'https://api.aldi.com.au';
const SITE = 'https://www.aldi.com.au';
const LIMIT = 60;

export function flatten(nodes, out = [], depth = 0) {
  for (const n of nodes ?? []) {
    // Top-level categories only: the search for a category includes everything under it.
    if (depth === 0 && n?.key) out.push({ key: n.key, name: n.name, slug: n.urlSlugText });
  }
  return out;
}

export async function categories(http) {
  const r = await http.get(`${API}/v2/product-category-tree?serviceType=walk-in`, { headers: { Accept: 'application/json', Origin: SITE, Referer: `${SITE}/` } });
  const j = r.json();
  return flatten(j?.data).filter((c) => !/liquor|alcohol/i.test(`${c.name} ${c.slug}`));
}

const cents = (v) => (typeof v === 'number' ? Math.round(v) / 100 : undefined);

export function parseProduct(p, cat) {
  if (!p?.sku || !p.name) return undefined;
  const price = cents(p.price?.amount);
  if (!price) return undefined;
  const was = cents(p.price?.wasPrice ?? p.price?.was);
  const img = (p.assets ?? []).find((a) => a?.url)?.url;
  const size = p.sellingSize || undefined;
  return {
    id: `aldi:${p.sku}`,
    chain: 'aldi',
    store_product_id: String(p.sku),
    name: String(p.name).trim(),
    brand: p.brandName || undefined,
    size,
    barcode: undefined, // Aldi's site doesn't show barcodes
    image_url: img ? String(img).replace('{width}', '500').replace('{slug}', p.urlSlugText ?? 'product') : undefined,
    ...readSize(size, p.name),
    price: {
      price,
      was_price: was && was > price ? was : undefined,
      is_special: !!(was && was > price) || /special/i.test(String(p.badges?.map?.((b) => b?.text).join(' ') ?? '')),
      member_only: false,
      promo: undefined,
    },
    details: {
      category: cat?.name,
      unit_price: p.price?.comparisonDisplay || undefined,
      url: p.urlSlugText ? `${SITE}/product/${p.urlSlugText}-${p.sku}` : undefined,
    },
  };
}

export function parsePage(j, cat) {
  const out = [];
  for (const p of j?.data ?? []) {
    const product = parseProduct(p, cat);
    if (product) out.push(product);
  }
  return { products: out, total: Number(j?.meta?.pagination?.totalCount ?? 0) };
}

// Aldi's category list needs a store ("service point"), but its search doesn't. So: the search,
// word by word, across the range (the way the Restock app searches Aldi), each product kept once.
export const WORDS = (process.env.ALDI_WORDS ||
  'milk,cheese,yoghurt,butter,cream,eggs,bread,wraps,cereal,oats,muesli,rice,pasta,noodles,flour,sugar,oil,sauce,soup,stock,beans,tomatoes,tuna,salmon,chicken,beef,lamb,pork,sausages,mince,bacon,ham,salami,fish,prawns,vegetables,fruit,apples,bananas,potatoes,onions,salad,frozen,ice cream,pizza,pies,chips,crackers,biscuits,chocolate,lollies,nuts,snacks,muesli bars,coffee,tea,juice,water,soft drink,cordial,energy drink,baby,nappies,wipes,toilet paper,tissues,paper towel,dishwashing,laundry,cleaner,bin bags,foil,cling wrap,shampoo,conditioner,body wash,soap,toothpaste,toothbrush,deodorant,razor,sunscreen,vitamins,pain relief,dog,cat,pet,spices,herbs,honey,jam,spread,peanut butter,vinegar,mayonnaise,mustard,dressing,dips,olives,pickles,curry,tortilla,taco,baking,yeast,cocoa,custard,dessert,jelly,cake,muffins,croissants,bagels,gluten free,vegan,protein,sports drink,kombucha,coconut,almond,soy,oat milk,lactose free,organic').split(',').map((w) => w.trim()).filter(Boolean);

export async function* collect(http, log) {
  log(`aldi: searching ${WORDS.length} words`);
  const seen = new Set();
  for (const word of WORDS) {
    for (let offset = 0; offset < 600; offset += LIMIT) {
      const r = await http.get(
        `${API}/v3/product-search?currency=AUD&serviceType=walk-in&q=${encodeURIComponent(word)}&limit=${LIMIT}&offset=${offset}&sort=relevance`,
        { headers: { Accept: 'application/json', Origin: SITE, Referer: `${SITE}/` } },
      );
      const { products, total } = parsePage(r.json(), { name: word });
      const fresh = products.filter((p) => !seen.has(p.id));
      for (const p of fresh) seen.add(p.id);
      yield fresh;
      if (!products.length || offset + LIMIT >= total) break;
    }
  }
}
