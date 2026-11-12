// Hand-made examples in the shape each shop's site answers with (not real captures).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSize } from '../lib/size.mjs';
import { fold, split, latestFile, readGz } from '../lib/store.mjs';
import { Client, ShopBlocked, looksLikeRobotCheck } from '../lib/http.mjs';
import * as woolworths from '../shops/woolworths.mjs';
import * as coles from '../shops/coles.mjs';
import * as aldi from '../shops/aldi.mjs';
import * as costco from '../shops/costco.mjs';

test('sizes', () => {
  assert.deepEqual(readSize('3L'), { qty: 3000, qty_unit: 'ml' });
  assert.deepEqual(readSize('1Kg'), { qty: 1000, qty_unit: 'g' });
  assert.deepEqual(readSize('10x375ml'), { qty: 3750, qty_unit: 'ml' });
  assert.deepEqual(readSize('Coke 375mL x 24'), { qty: 9000, qty_unit: 'ml' });
  assert.deepEqual(readSize('500mg'), { qty: 0.5, qty_unit: 'g' });
  assert.deepEqual(readSize('24 pack'), { qty: 24, qty_unit: 'ea' });
  assert.deepEqual(readSize('Toilet Paper 100 sheets'), { qty: 100, qty_unit: 'ea' });
  assert.deepEqual(readSize('each'), { qty: 1, qty_unit: 'ea' });
  assert.deepEqual(readSize(undefined, 'Milk 2L'), { qty: 2000, qty_unit: 'ml' });
  assert.deepEqual(readSize('Holiday Dog Greeter'), {});
});

test('woolworths page', () => {
  const j = {
    TotalRecordCount: 2,
    Bundles: [
      { Products: [{ Stockcode: 123, DisplayName: 'Woolworths Full Cream Milk 2L', Brand: 'Woolworths', Price: 3.1, WasPrice: 3.1, IsOnSpecial: false, PackageSize: '2L', Barcode: '9300633603205', MediumImageFile: 'https://cdn0.woolworths.media/x.jpg', CupString: '$1.55 / 1L' }] },
      { Products: [{ Stockcode: 456, Name: 'Tim Tam', Price: 2.75, WasPrice: 5.5, IsOnSpecial: true, IsHalfPrice: true, PackageSize: '200g' }] },
    ],
  };
  const { products, total } = woolworths.parsePage(j, { name: 'Dairy' });
  assert.equal(total, 2);
  assert.equal(products[0].barcode, '9300633603205');
  assert.equal(products[0].qty, 2000);
  assert.equal(products[0].price.was_price, undefined);
  assert.equal(products[1].price.was_price, 5.5);
  assert.equal(products[1].price.promo, 'Half price');
  assert.equal(products[1].details.category, 'Dairy');
});

test('coles page and build number', () => {
  assert.equal(coles.buildIdOf('<script id="__NEXT_DATA__">{"buildId":"20261101.1-abc","page":"/"}</script>'), '20261101.1-abc');
  const j = {
    pageProps: {
      searchResults: {
        noOfResults: 2,
        pageSize: 48,
        results: [
          { _type: 'PRODUCT', id: 8150288, name: 'Full Cream Milk', brand: 'Coles', size: '3L', pricing: { now: 4.95, comparable: '$1.65 per 1L' }, imageUris: [{ uri: '/8/8150288.jpg' }] },
          { _type: 'PRODUCT', id: 1913790, name: 'Full Cream Milk', brand: 'Devondale', size: '2L', pricing: { now: 4.2, was: 4.7, promotionType: 'SPECIAL' } },
          { _type: 'SINGLE_TILE', id: 'ad' },
        ],
      },
    },
  };
  const { products } = coles.parsePage(j, { name: 'Dairy' });
  assert.equal(products.length, 2);
  assert.equal(products[0].name, 'Coles Full Cream Milk');
  assert.equal(products[0].image_url, 'https://productimages.coles.com.au/productimages/8/8150288.jpg');
  assert.equal(products[1].price.is_special, true);
  assert.equal(products[1].price.was_price, 4.7);
});

test('aldi page', () => {
  const j = {
    meta: { pagination: { totalCount: 1 } },
    data: [{ sku: '000000000000123', name: 'Coconut Cream 400ml', brandName: 'THE ODD BUNCH', sellingSize: '0.4 l', price: { amount: 129, comparisonDisplay: '$0.32 per 100 ml' }, assets: [{ url: 'https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/{width}/abc/{slug}' }], urlSlugText: 'coconut-cream' }],
  };
  const { products } = aldi.parsePage(j, { name: 'Pantry' });
  assert.equal(products[0].price.price, 1.29);
  assert.equal(products[0].qty, 400);
  assert.match(products[0].image_url, /scaleWidth\/500\/abc\/coconut-cream$/);
});

test('costco page: everything Costco sells', () => {
  const j = {
    pagination: { totalPages: 3 },
    products: [
      { code: '202', name: 'Kirkland Signature Adult Dog Food 18kg', price: { value: 69.99 }, url: '/p/202', images: [{ url: '/medias/202.jpg' }], categories: [{ name: 'Pets' }] },
      { code: '303', name: 'Sofa 3 Seater', price: { value: 899 } },
    ],
  };
  const { products, pages } = costco.parsePage(j);
  assert.equal(pages, 3);
  assert.equal(products.length, 2);
  assert.equal(products[0].qty, 18000);
  assert.equal(products[0].details.online_price_includes_delivery, true);
});

test('history keeps only changes, and latest/ is Restock import format', () => {
  const state = { products: {} };
  const milk = (price, extra = {}) => ({ id: 'coles:1', chain: 'coles', store_product_id: '1', name: 'Milk', size: '2L', qty: 2000, qty_unit: 'ml', price: { price, ...extra } });
  assert.equal(fold(state, [milk(3.4)], '2026-01-01'), 1);
  assert.equal(fold(state, [milk(3.4)], '2026-01-08'), 0); // same price: nothing new
  assert.equal(fold(state, [milk(2.9, { is_special: true, was_price: 3.4 })], '2026-01-15'), 1);
  assert.equal(state.products['coles:1'].prices.length, 2);
  assert.equal(state.products['coles:1'].seen, '2026-01-15');
  // A year and a bit later (still on sale): the old points move to history, the last one before the cutoff stays.
  fold(state, [milk(3.6)], '2027-02-01');
  const old = split(state, '2027-02-01');
  assert.deepEqual(state.products['coles:1'].prices.map((x) => x.price), [2.9, 3.6]);
  assert.deepEqual(Object.keys(old), ['2026']);
  const f = latestFile('coles', state);
  assert.equal(f.format, 'restock-export');
  assert.deepEqual(Object.keys(f.tables.products[0]).sort(), ['chain', 'id', 'name', 'prices', 'qty', 'qty_unit', 'size', 'store_product_id']);
});

test('a shop that keeps refusing stops cleanly', async () => {
  const c = new Client('coles', { delayMs: 0, jitterMs: 1, sleepImpl: async () => {}, fetchImpl: async () => new Response('<title>Access Denied</title>', { status: 403 }) });
  await assert.rejects(() => c.get('https://www.coles.com.au/'), ShopBlocked);
  assert.ok(looksLikeRobotCheck('<html>Request unsuccessful. Incapsula incident ID: 1</html>'));
});

test('a run writes latest/ and the state, even when the shop stops part way', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  process.env.DATA_DIR = dir;
  const { runShop } = await import('../collect.mjs');
  const fake = { requests: 0 };
  const orig = woolworths.collect;
  const shops = (await import('../collect.mjs')).SHOP_CODE;
  shops.woolworths = {
    async *collect() {
      yield [woolworths.parseProduct({ Stockcode: 1, Name: 'Milk 2L', Price: 3.1, PackageSize: '2L' }, { name: 'Dairy' })];
      throw new ShopBlocked('woolworths', 'HTTP 403');
    },
  };
  try {
    const r = await runShop('woolworths', { client: fake, day: '2026-11-12', root: join(dir, 'out'), stateDir: join(dir, 'state') });
    assert.equal(r.status, 'blocked');
    assert.equal(r.count, 1);
    const latest = readGz(join(dir, 'out', 'latest', 'woolworths.json.gz'));
    assert.equal(latest.tables.products[0].prices[0].price, 3.1);
    // 0.9.14: the window index says when the shop was last fully collected (a blocked run isn't).
    const { readFileSync } = await import('node:fs');
    const index = JSON.parse(readFileSync(join(dir, 'out', 'window', 'index.json'), 'utf8'));
    assert.equal(index.shops.woolworths.to, '2026-11-12');
    assert.equal(index.shops.woolworths.full, '2026-11-12'); // first time: the day it was written
    assert.ok(index.updated);
  } finally {
    shops.woolworths = { ...woolworths, collect: orig };
    rmSync(dir, { recursive: true, force: true });
  }
});

test('woolworths from hotprices: months of past prices at once', () => {
  const p = woolworths.fromHotprices({ id: '123.0', name: 'Woolworths Milk 2L', isWeighted: false, unit: 'ml', quantity: 2000, priceHistory: [{ date: '2026-11-10', price: 3.1 }, { date: '2026-06-01', price: 2.9 }] });
  assert.equal(p.store_product_id, '123');
  assert.equal(p.price.price, 3.1);
  assert.equal(p.qty, 2000);
  const state = { products: {} };
  fold(state, [p], '2026-11-12');
  assert.deepEqual(state.products['woolworths:123'].prices.map((x) => [x.date, x.price]), [['2026-06-01', 2.9], ['2026-11-10', 3.1]]);
});

test('aldi searches words and keeps each product once', async () => {
  const page = { meta: { pagination: { totalCount: 1 } }, data: [{ sku: '1', name: 'Milk 2L', price: { amount: 310 } }] };
  const http = { get: async () => ({ json: () => page }) };
  const got = [];
  for await (const b of aldi.collect(http, () => {})) got.push(...b);
  assert.equal(got.length, 1);
});

test('coles: a robot check means hotprices.org for this run', async () => {
  const pardon = '<html><noscript><title>Pardon Our Interruption</title></noscript></html>';
  assert.ok(looksLikeRobotCheck(pardon));
  let asked = 0;
  const http = {
    get: async () => { throw new ShopBlocked('coles', 'a robot check page'); },
    fetch: async (url) => { asked++; assert.match(url, /coles\.compressed/); return new Response(JSON.stringify([{ id: 8150288, name: 'Coles Full Cream Milk 3L', priceHistory: [{ date: '2026-11-10', price: 4.95 }] }])); },
  };
  const got = [];
  for await (const b of coles.collect(http, () => {})) got.push(...b);
  assert.equal(asked, 1);
  assert.equal(got[0].image_url, 'https://productimages.coles.com.au/productimages/8/8150288.jpg');
  assert.equal(got[0].qty, 3000);
});

test('prices fit in date order, so the price helper phone can send earlier days', async () => {
  const { put } = await import('../lib/store.mjs');
  const prices = [{ date: '2026-11-12', price: 3 }];
  assert.equal(put(prices, { date: '2026-11-09', price: 2.5, is_special: true }), true);
  assert.equal(put(prices, { date: '2026-11-10', price: 2.5, is_special: true }), false); // same as the day before
  assert.equal(put(prices, { date: '2026-11-12', price: 3 }), false);
  assert.deepEqual(prices.map((p) => p.date), ['2026-11-09', '2026-11-12']);
});

test('price helper: only the right key, only tidy products, folded in at the next run', async () => {
  const { startHelper, cleanProduct } = await import('../lib/helper.mjs');
  const today = () => '2026-11-12';
  assert.equal(cleanProduct('coles', { store_product_id: '../x', name: 'Milk', price: { price: 3 }, day: '2026-11-11' }, '2026-11-12'), undefined);
  assert.equal(cleanProduct('coles', { store_product_id: '1', name: 'Milk', price: { price: 3 }, day: '2026-10-01' }, '2026-11-12'), undefined);
  const ok = cleanProduct('coles', { store_product_id: '8150288', name: 'Coles Milk', size: '3L', price: { price: 4.95, was_price: 5.5, is_special: true }, day: '2026-11-10', extra: 'x' }, '2026-11-12');
  assert.equal(ok.qty, 3000);
  assert.equal(ok.extra, undefined);
  const dir = mkdtempSync(join(tmpdir(), 'rph-'));
  const server = startHelper({ dataDir: dir, key: 'sekrit', port: 0, today, log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/helper/status`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
    assert.equal((await fetch(`${base}/helper/status`, { headers: { Authorization: 'Bearer sekrit' } })).status, 200);
    const body = { format: 'restock-helper', version: 1, chain: 'coles', products: [{ store_product_id: '8150288', name: 'Coles Milk', size: '3L', price: { price: 4.95 }, day: '2026-11-10' }, { name: 'no id' }] };
    const r = await fetch(`${base}/helper/prices`, { method: 'POST', headers: { Authorization: 'Bearer sekrit', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual(await r.json(), { ok: true, kept: 1 });
    const { foldInbox } = await import('../collect.mjs');
    const state = { products: {} };
    assert.deepEqual(foldInbox(state, 'coles', dir), { count: 1, changed: 1 });
    assert.deepEqual(state.products['coles:8150288'].prices, [{ date: '2026-11-10', price: 4.95 }]);
    assert.deepEqual(foldInbox(state, 'coles', dir), { count: 0, changed: 0 }); // taken once
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run missed while the container was off happens when it starts again', async () => {
  const { lastRunDue, missedRun } = await import('../collect.mjs');
  const fri = new Date(2026, 10, 13, 9, 0); // Friday 13 Nov 2026, 9 am
  const due = lastRunDue(fri);
  assert.equal(due.getDay(), 4); // Thursday
  assert.equal(due.getHours(), 1);
  assert.equal(due.getDate(), 12);
  const before = { woolworths: { at: new Date(2026, 10, 5, 2).toISOString() } };
  assert.equal(missedRun(before, fri), true);
  const after = { woolworths: { at: new Date(2026, 10, 12, 3).toISOString() } };
  assert.equal(missedRun(after, fri), false);
  assert.equal(missedRun({}, fri), false);
  const wedNight = new Date(2026, 10, 11, 23, 0); // before this week's run: last week's counts
  assert.equal(lastRunDue(wedNight).getDate(), 5);
});

test('day-one window files: just ids and prices, starting with the price in force', async () => {
  const { windowFile } = await import('../lib/store.mjs');
  const state = { products: {
    'coles:1': { store_product_id: '1', name: 'Milk', prices: [{ date: '2026-01-01', price: 3.4 }, { date: '2026-10-20', price: 2.9, is_special: true }, { date: '2026-11-03', price: 3.4 }] },
    'coles:2': { store_product_id: '2', name: 'Gone', stale: true, prices: [{ date: '2026-11-01', price: 1 }] },
  } };
  const w = windowFile('coles', state, '2026-11-12', 56);
  assert.equal(w.format, 'restock-window');
  assert.equal(w.from, '2026-09-17');
  assert.deepEqual(w.products['1'], [[0, 340], [33, 290, 1], [47, 340]]);
  assert.equal(w.products['2'], undefined);
  assert.equal(Object.keys(w.products).length, 1);
});

test('feedback: kept with its screenshots, read behind the password, marked done', async () => {
  const { startHelper } = await import('../lib/helper.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rpf-'));
  const server = startHelper({ dataDir: dir, key: undefined, port: 0, today: () => '2026-11-12', log: () => {}, feedbackPassword: 'pw' });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64');
    const send = (b) => fetch(`${base}/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const ok = await send({ format: 'restock-feedback', install: 'phone-1', kind: 'wrong', message: 'Pick my <b>milk</b> does nothing', app: '0.9.13', platform: 'android', diagnostics: { v: 1 }, screenshots: [{ type: 'image/jpeg', data: jpeg }, { type: 'image/png', data: jpeg }] });
    assert.equal(ok.status, 200);
    assert.equal((await send({ format: 'restock-feedback', message: '' })).status, 400);
    for (let i = 0; i < 4; i++) await send({ format: 'restock-feedback', install: 'phone-1', message: `more ${i}` });
    assert.equal((await send({ format: 'restock-feedback', install: 'phone-1', message: 'six' })).status, 429);
    assert.equal((await fetch(`${base}/feedback/inbox`)).status, 401);
    const auth = { Authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` };
    const list = await (await fetch(`${base}/feedback/inbox`, { headers: auth })).text();
    assert.match(list, /5 messages, 5 not done yet/);
    assert.match(list, /Pick my &lt;b&gt;milk&lt;\/b&gt;/); // never as HTML
    const { id } = await ok.json();
    const one = await (await fetch(`${base}/feedback/inbox/${id}`, { headers: auth })).text();
    assert.match(one, /shot-1\.jpg/);
    assert.doesNotMatch(one, /shot-2/); // the "png" wasn't a picture
    assert.equal((await fetch(`${base}/feedback/inbox/${id}/shot-1.jpg`, { headers: auth })).headers.get('content-type'), 'image/jpeg');
    await fetch(`${base}/feedback/inbox/${id}/done`, { method: 'POST', headers: auth, redirect: 'manual' });
    assert.match(await (await fetch(`${base}/feedback/inbox`, { headers: auth })).text(), /4 not done yet/);
    assert.equal((await fetch(`${base}/helper/status`)).status, 401); // no helper key: helper uploads stay shut
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hotprices.org's past prices never replace the shop's own reading for that day", async () => {
  const state = { products: {} };
  const own = { id: 'coles:1', chain: 'coles', store_product_id: '1', name: 'Milk', price: { price: 2.5, is_special: true, was_price: 3.4 } };
  fold(state, [own], '2026-11-10');
  const hp = { id: 'coles:1', chain: 'coles', store_product_id: '1', name: 'Milk', price: { price: 3.4 }, history: [{ date: '2026-11-10', price: 2.5 }, { date: '2026-11-01', price: 3.4 }] };
  fold(state, [hp], '2026-11-12');
  assert.deepEqual(state.products['coles:1'].prices.map((x) => [x.date, x.price, !!x.is_special]), [['2026-11-01', 3.4, false], ['2026-11-10', 2.5, true], ['2026-11-12', 3.4, false]]);
});

test('0.9.14 prices from phones: no key, checked, the collector wins, odd ones wait for a second phone', async () => {
  const { startHelper } = await import('../lib/helper.mjs');
  const { foldPhones } = await import('../lib/share.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'rps-'));
  const server = startHelper({ dataDir: dir, key: 'sekrit', port: 0, today: () => '2026-11-12', log: () => {} });
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (install, chain, products) =>
    fetch(`${base}/share/prices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'restock-share', v: 1, install, chain, products }) });
  const p = (id, price, day = '2026-11-11', extra = {}) => ({ store_product_id: id, name: `Thing ${id}`, price: { price }, day, ...extra });
  try {
    assert.equal((await send('phone-aaaa', 'bws', [p('1', 3)])).status, 400); // not a shop that's collected
    assert.equal((await send('x', 'coles', [p('1', 3)])).status, 400); // no install number
    const ok = await send('phone-aaaa', 'aldi', [p('100', 3.49), p('200', 9), p('300', 2.5), p('400', 4), p('400', 1, '2026-11-11'), { name: 'no id' }]);
    assert.deepEqual(await ok.json(), { ok: true, kept: 5 });
    assert.equal((await send('phone-bbbb', 'aldi', [p('400', 4)])).status, 200);
    // What the collector already knows: 100 at $3.49 (the phone agrees), 200 at $3 (the phone says $9:
    // odd), and its own reading of 300 on the 11th, with its own name.
    const state = {
      products: {
        'aldi:100': { store_product_id: '100', name: 'Aldi Milk', prices: [{ date: '2026-11-01', price: 3.49 }] },
        'aldi:200': { store_product_id: '200', name: 'Aldi Bread', prices: [{ date: '2026-11-01', price: 3 }] },
        'aldi:300': { store_product_id: '300', name: 'Aldi Eggs', prices: [{ date: '2026-11-11', price: 2.9 }] },
      },
    };
    const r = foldPhones(state, 'aldi', dir, '2026-11-12');
    // 100: nothing new (same price). 200: held. 300: the collector's reading stays. 400 ($4): new, two phones agree. 400 ($1): one phone, held.
    assert.deepEqual(state.products['aldi:200'].prices, [{ date: '2026-11-01', price: 3 }]);
    assert.deepEqual(state.products['aldi:300'].prices, [{ date: '2026-11-11', price: 2.9 }]);
    assert.equal(state.products['aldi:300'].name, 'Aldi Eggs');
    assert.deepEqual(state.products['aldi:400'].prices, [{ date: '2026-11-11', price: 4 }]);
    assert.equal(r.held, 2);
    assert.equal(r.phones, 2);
    // A second phone agrees about 200 at $9 (bread went up?): in it goes at the next fold.
    assert.equal((await send('phone-cccc', 'aldi', [p('200', 9)])).status, 200);
    const r2 = foldPhones(state, 'aldi', dir, '2026-11-12');
    assert.deepEqual(state.products['aldi:200'].prices.at(-1), { date: '2026-11-11', price: 9 });
    assert.equal(r2.held, 1); // 400 at $1 still waits
    // Held ones are let go after 14 days.
    assert.equal(foldPhones(state, 'aldi', dir, '2026-11-30').held, 0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
