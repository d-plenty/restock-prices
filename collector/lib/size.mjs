// Pack sizes into an amount Restock can compare: grams (g), millilitres (ml) or a count (ea).
// "3L" -> 3000 ml, "1Kg" -> 1000 g, "10x375ml" -> 3750 ml, "24 pack" -> 24 ea, "100 sheets" -> 100 ea.

const UNIT = {
  mg: ['g', 0.001],
  g: ['g', 1],
  gm: ['g', 1],
  gram: ['g', 1],
  grams: ['g', 1],
  kg: ['g', 1000],
  kilo: ['g', 1000],
  ml: ['ml', 1],
  millilitre: ['ml', 1],
  millilitres: ['ml', 1],
  cl: ['ml', 10],
  l: ['ml', 1000],
  lt: ['ml', 1000],
  ltr: ['ml', 1000],
  litre: ['ml', 1000],
  litres: ['ml', 1000],
  liter: ['ml', 1000],
};
const COUNT = /^(pack|pk|each|ea|piece|pieces|pcs|sheets?|rolls?|capsules?|caps|tablets?|tabs|bags?|pods?|sachets?|wipes?|serves?|x)$/i;

const num = (s) => Number(String(s).replace(',', '.'));

/** { qty, qty_unit } or {} when the size can't be read with confidence. */
export function readSize(...texts) {
  for (const raw of texts) {
    if (!raw) continue;
    const t = String(raw).toLowerCase().replace(/\s+/g, ' ');
    // "10 x 375ml", "6x200ml", "4 x 1.25L"
    let m = t.match(/(\d+)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(mg|kg|g|gm|ml|cl|l|lt|ltr)\b/);
    if (m && UNIT[m[3]]) {
      const [u, f] = UNIT[m[3]];
      return { qty: round(num(m[1]) * num(m[2]) * f), qty_unit: u };
    }
    // "375ml x 10"
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(mg|kg|g|gm|ml|cl|l|lt|ltr)\s*[x×*]\s*(\d+)\b/);
    if (m && UNIT[m[2]]) {
      const [u, f] = UNIT[m[2]];
      return { qty: round(num(m[1]) * num(m[3]) * f), qty_unit: u };
    }
    // "2L", "400 g", "1.5kg"
    m = t.match(/(\d+(?:[.,]\d+)?)\s*(mg|kg|grams?|gm|g|millilitres?|ml|cl|litres?|liter|ltr|lt|l)\b/);
    if (m && UNIT[m[2]]) {
      const [u, f] = UNIT[m[2]];
      const q = round(num(m[1]) * f);
      if (q > 0) return { qty: q, qty_unit: u };
    }
    // "24 pack", "100 sheets", "each"
    m = t.match(/(\d+)\s*(pack|pk|piece|pieces|pcs|sheets?|rolls?|capsules?|caps|tablets?|tabs|bags?|pods?|sachets?|wipes?)\b/);
    if (m && COUNT.test(m[2])) return { qty: Number(m[1]), qty_unit: 'ea' };
    if (/^\s*(1\s*)?(each|ea)\s*$/.test(t)) return { qty: 1, qty_unit: 'ea' };
  }
  return {};
}

const round = (n) => Math.round(n * 1000) / 1000;
