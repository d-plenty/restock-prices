#!/usr/bin/env node
// Restock prices collector.
//   node collect.mjs             wait and run on schedule (Thursday 1:00 am, retry Friday 1:00 am)
//   node collect.mjs run [shop…] run now (all shops, or the ones named), then publish
//   node collect.mjs probe [shop] fetch one page per shop, save what came back to /data/probe, and say
//                                what it understood. Send those files if a shop stops working.
//   node collect.mjs inbox       fold in what the price helper phone and other phones sent now, and publish
//                                (it also does this every night at NIGHTLY_TIME, 3:00 am unless changed)
// With HELPER_KEY set, it also takes uploads from a Restock price helper phone (lib/helper.mjs).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ShopBlocked } from './lib/http.mjs';
import { detailsFile, fold, latestFile, readGz, split, writeGz, writeHistory, writeWindows } from './lib/store.mjs';
import * as woolworths from './shops/woolworths.mjs';
import * as coles from './shops/coles.mjs';
import * as aldi from './shops/aldi.mjs';
import * as costco from './shops/costco.mjs';
import { HELPER_SHOPS, readInbox, startHelper } from './lib/helper.mjs';
import { foldPhones, SHARE_SHOPS } from './lib/share.mjs';

export const SHOP_CODE = { woolworths, coles, aldi, costco };
const DATA = process.env.DATA_DIR || '/data';
const OUT = join(DATA, 'out');
const STATE = join(DATA, 'state');
const SHOPS = (process.env.SHOPS || 'woolworths,coles,aldi,costco')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s) => SHOP_CODE[s]);
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RUN_DAY = (process.env.RUN_DAY || 'thu').toLowerCase();
const RETRY_DAY = (process.env.RETRY_DAY || 'fri').toLowerCase();
const RUN_TIME = process.env.RUN_TIME || '01:00';
// 0.9.14: every night, what the phones sent goes in and the day-one files are published again.
const NIGHTLY_TIME = process.env.NIGHTLY_TIME || '03:00';
const SHORT = Number(process.env.SHORT_FRACTION || 0.7); // fewer than 70% of last good run = retry

const log = (...a) => console.log(new Date().toISOString(), ...a);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Australia/Brisbane' }).format(new Date());

function runs() {
  const p = join(STATE, 'runs.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}
function saveRuns(r) {
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, 'runs.json'), JSON.stringify(r, null, 2));
}

/** Collect one shop, fold it into its state, write its files. Returns { status, count, changed }. */
export async function runShop(shop, { client, day = today(), root = OUT, stateDir = STATE } = {}) {
  const http = client ?? new Client(shop);
  const seen = new Map();
  let status = 'ok';
  let why;
  try {
    for await (const page of SHOP_CODE[shop].collect(http, log)) for (const p of page) seen.set(p.id, p);
  } catch (e) {
    status = e instanceof ShopBlocked ? 'blocked' : 'failed';
    why = String(e?.message || e);
    log(`${shop}: ${why}`);
  }
  const statePath = join(stateDir, `${shop}.json.gz`);
  const state = readGz(statePath, { products: {} });
  const prev = runs()[shop];
  // A run that stopped early still keeps what it found; it just doesn't count as a good run.
  let changed = fold(state, [...seen.values()], day);
  const helped = foldInbox(state, shop, dataDirOf(stateDir));
  changed += helped.changed;
  const phoned = foldPhones(state, shop, dataDirOf(stateDir), day);
  changed += phoned.changed;
  writeShop(shop, state, day, root, statePath, { full: status === 'ok' || status === 'short' });
  const short = prev?.good && seen.size < prev.good * SHORT;
  if (status === 'ok' && short) status = 'short';
  log(`${shop}: ${seen.size} products, ${changed} new prices, ${http.requests} requests, ${status}${helped.count ? `, ${helped.count} prices from the price helper phone` : ''}${phoned.count ? `, ${phoned.count} from ${phoned.phones} phones` : ''}`);
  return { status, count: seen.size, changed, why, helper: helped.count, phones: phoned.count, held: phoned.held, good: status === 'ok' ? seen.size : prev?.good };
}

const dataDirOf = (stateDir) => join(stateDir, '..');

/** The state, its year files and latest/ files, written out. */
function writeShop(shop, state, day, root, statePath, { full = false } = {}) {
  const old = split(state, day);
  writeGz(statePath, state);
  writeHistory(root, shop, old);
  writeGz(join(root, 'latest', `${shop}.json.gz`), latestFile(shop, state));
  writeGz(join(root, 'latest', `${shop}-details.json.gz`), detailsFile(shop, state));
  // Restock 0.9.13: the small day-one files, and their sizes for the app's size guide.
  const sizes = writeWindows(root, shop, state, day);
  const indexPath = join(root, 'window', 'index.json');
  let index = {};
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    // first time
  }
  index.format = 'restock-window-index';
  index.v = 1;
  // `full`: the day of the shop's last full collection (Thursday's run), so a phone set to weekly
  // downloads once that's in; `to` moves on every night as phones' prices come in (0.9.14).
  const was = index.shops?.[shop];
  index.updated = new Date().toISOString();
  index.shops = {
    ...(index.shops ?? {}),
    [shop]: { to: day, full: full ? day : (was?.full ?? day), products: Object.values(state.products ?? {}).filter((p) => !p.stale).length, bytes: sizes },
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 1) + '\n');
}

/** What the price helper phone sent for this shop, folded in on the days it saw them. */
export function foldInbox(state, shop, dataDir = DATA) {
  if (!HELPER_SHOPS.includes(shop)) return { count: 0, changed: 0 };
  const { products, done } = readInbox(dataDir, shop);
  const byDay = new Map();
  for (const p of products) {
    if (!p?.day) continue;
    // A week from the helper phone is tens of thousands of prices: added to, not copied each time.
    const list = byDay.get(p.day);
    if (list) list.push(p);
    else byDay.set(p.day, [p]);
  }
  let changed = 0;
  for (const d of [...byDay.keys()].sort()) changed += fold(state, byDay.get(d), d);
  done();
  return { count: products.length, changed };
}

/** `inbox`: fold in the price helper's prices now, without asking the shops, and publish. */
async function inboxNow() {
  const r = runs();
  for (const shop of SHOPS) {
    const statePath = join(STATE, `${shop}.json.gz`);
    const state = readGz(statePath, { products: {} });
    const helped = HELPER_SHOPS.includes(shop) ? foldInbox(state, shop) : { count: 0, changed: 0 };
    const phoned = SHARE_SHOPS.includes(shop) ? foldPhones(state, shop, DATA, today()) : { count: 0, changed: 0, held: 0, phones: 0 };
    if (!Object.keys(state.products).length) continue; // never collected: nothing to publish
    writeShop(shop, state, today(), OUT, statePath);
    r[shop] = { ...(r[shop] ?? {}), nightly: { at: new Date().toISOString(), helper: helped.count, phones: phoned.count, fromPhones: phoned.phones, held: phoned.held, changed: helped.changed + phoned.changed } };
    log(`${shop}: ${helped.count} prices from the price helper phone, ${phoned.count} from ${phoned.phones} phones (${phoned.held} waiting for a second phone), ${helped.changed + phoned.changed} new`);
  }
  saveRuns(r);
  try {
    publish(r);
  } catch (e) {
    log(`publish failed: ${e.message}`);
  }
}

function summary(r) {
  const lines = ['# Last run', '', '| Shop | When | Products | New prices | From the price helper phone | From phones | Result |', '|---|---|---|---|---|---|---|'];
  for (const s of Object.keys(SHOP_CODE)) {
    const x = r[s];
    if (x?.at) lines.push(`| ${s} | ${x.at} | ${x.count} | ${x.changed} | ${HELPER_SHOPS.includes(s) ? (x.helper ?? 0) : '–'} | ${x.phones ?? 0} | ${x.status}${x.why ? `: ${x.why.replace(/\|/g, '/')}` : ''} |`);
  }
  // 0.9.14: last night's fold of what the phones sent.
  const nights = Object.keys(SHOP_CODE).filter((s) => r[s]?.nightly);
  if (nights.length) {
    lines.push('', '# Last night', '', '| Shop | When | From the price helper phone | From phones | Phones | Waiting for a second phone | New prices |', '|---|---|---|---|---|---|---|');
    for (const s of nights) {
      const n = r[s].nightly;
      lines.push(`| ${s} | ${n.at} | ${HELPER_SHOPS.includes(s) ? n.helper : '–'} | ${n.phones} | ${n.fromPhones} | ${n.held} | ${n.changed} |`);
    }
  }
  // Restock 0.9.13: the day-one download sizes, as the app shows them.
  try {
    const index = JSON.parse(readFileSync(join(OUT, 'window', 'index.json'), 'utf8'));
    const kb = (b) => (b >= 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`);
    lines.push('', '# Day-one downloads (what a phone downloads for each shop)', '', '| Shop | Products | 8 weeks | 6 months | 12 months |', '|---|---|---|---|---|');
    for (const [shop, x] of Object.entries(index.shops ?? {})) lines.push(`| ${shop} | ${x.products} | ${kb(x.bytes[56])} | ${kb(x.bytes[182])} | ${kb(x.bytes[365])} |`);
  } catch {
    // no window files yet
  }
  return `${lines.join('\n')}\n`;
}

/** Copy out/ into the git repo and push (only when GITHUB_TOKEN and GIT_REPO are set). */
function publish(r) {
  writeFileSync(join(OUT, 'STATUS.md'), summary(r));
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GIT_REPO;
  if (!token || !repo) {
    log('publish: GITHUB_TOKEN or GIT_REPO not set, files are in /data/out only');
    return;
  }
  const dir = join(DATA, 'repo');
  const url = `https://x-access-token:${token}@github.com/${repo}.git`;
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  const quiet = (fn) => {
    try {
      return fn();
    } catch (e) {
      // Never print the token.
      throw new Error(String(e?.stderr || e?.message || e).replaceAll(token, '***'));
    }
  };
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    quiet(() => execFileSync('git', ['clone', '--depth', '1', url, dir], { stdio: ['ignore', 'pipe', 'pipe'] }));
  } else {
    quiet(() => git('remote', 'set-url', 'origin', url));
    quiet(() => git('pull', '--rebase', '--depth', '1', 'origin', 'HEAD'));
  }
  // 0.9.14: window/ too (the day-one files phones download). 0.9.13 wrote them but didn't publish them.
  const subs = ['latest', 'history', 'window'].filter((sub) => existsSync(join(OUT, sub)));
  for (const sub of subs) cpSync(join(OUT, sub), join(dir, sub), { recursive: true });
  cpSync(join(OUT, 'STATUS.md'), join(dir, 'STATUS.md'));
  git('add', '-A', ...subs, 'STATUS.md');
  if (!git('status', '--porcelain').trim()) {
    log('publish: nothing changed');
    return;
  }
  git('-c', 'user.name=Restock prices', '-c', `user.email=${process.env.GIT_EMAIL || 'restock-prices@users.noreply.github.com'}`, 'commit', '-q', '-m', `Prices ${today()}`);
  quiet(() => git('push', '-q', 'origin', 'HEAD'));
  log('publish: pushed to GitHub');
}

export async function runNow(shops) {
  const r = runs();
  for (const s of shops) {
    const res = await runShop(s);
    r[s] = { at: new Date().toISOString(), ...res };
    saveRuns(r);
  }
  try {
    publish(r);
  } catch (e) {
    log(`publish failed: ${e.message}`);
  }
  return r;
}

async function probe(shops) {
  const dir = join(DATA, 'probe');
  mkdirSync(dir, { recursive: true });
  for (const s of shops) {
    console.log(`probe ${s}: starting`);
    const http = new Client(s, { delayMs: 1500, retries: 1, timeoutMs: 20_000, verbose: true });
    let n = 0;
    // Every answer, refused ones too, so a shop that says no can be looked at.
    http.onAnswer = (url, method, status, text) =>
      writeFileSync(join(dir, `${s}-${++n}.txt`), `${method} ${url}\nHTTP ${status}\n\n${String(text).slice(0, 300_000)}`);
    try {
      const it = SHOP_CODE[s].collect(http, log);
      const first = await it.next();
      const items = first.value ?? [];
      log(`probe ${s}: OK, ${items.length} products on the first page${items[0] ? `, e.g. "${items[0].name}" $${items[0].price.price}` : ''}`);
      await it.return?.();
    } catch (e) {
      log(`probe ${s}: FAILED: ${e.message}`);
    }
  }
  log(`probe: saved what each shop sent to ${dir}`);
}

/** Wait for RUN_DAY / RETRY_DAY at RUN_TIME (container time zone), once each per day. */
/**
 * When this week's run should have started: the last RUN_DAY at RUN_TIME up to now (local time).
 * Exported for the tests.
 */
export function lastRunDue(now = new Date()) {
  const [h, m] = RUN_TIME.split(':').map(Number);
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  const back = (now.getDay() - DAYS.indexOf(RUN_DAY) + 7) % 7;
  due.setDate(due.getDate() - back);
  if (due > now) due.setDate(due.getDate() - 7);
  return due;
}

/** True when the container was off (or restarting) at this week's run time, so it never ran. */
export function missedRun(r, now = new Date()) {
  const ats = SHOPS.map((s) => Date.parse(r[s]?.at ?? '')).filter((t) => Number.isFinite(t));
  if (!ats.length) return false; // never run: wait for the day, or `run`
  return Math.max(...ats) < lastRunDue(now).getTime() && now.getTime() - lastRunDue(now).getTime() < 6 * 86_400_000;
}

async function schedule() {
  startHelper({ dataDir: DATA, today, log });
  log(`waiting: ${SHOPS.join(', ')} every ${RUN_DAY} at ${RUN_TIME}, retry ${RETRY_DAY} for any shop that failed or came back short; phones' prices go in every night at ${NIGHTLY_TIME}`);
  let night = '';
  // 0.9.12: the container was off or restarting at run time (a TrueNAS update, a power cut): run now.
  let done = '';
  if (missedRun(runs())) {
    log(`missed this week's ${RUN_DAY} ${RUN_TIME} run (the container wasn't running then), so running now`);
    await runNow(SHOPS);
    // This week's run is done: not again if the catch-up started on the run day itself.
    done = `${today()} ${DAYS[new Date().getDay()]}`;
  }
  for (;;) {
    const now = new Date();
    const hm = now.toTimeString().slice(0, 5);
    const day = DAYS[now.getDay()];
    const key = `${today()} ${day}`;
    if (hm === NIGHTLY_TIME && night !== key) {
      night = key;
      await inboxNow();
    }
    if (hm === RUN_TIME && done !== key) {
      done = key;
      if (day === RUN_DAY) await runNow(SHOPS);
      else if (day === RETRY_DAY) {
        const r = runs();
        const again = SHOPS.filter((s) => r[s]?.status !== 'ok');
        if (again.length) {
          log(`retry: ${again.join(', ')}`);
          await runNow(again);
        }
      }
    }
    await new Promise((res) => setTimeout(res, 20_000));
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const named = rest.map((s) => s.toLowerCase()).filter((s) => SHOP_CODE[s]);
if (import.meta.url === `file://${process.argv[1]}`) {
  if (cmd === 'run') await runNow(named.length ? named : SHOPS);
  else if (cmd === 'probe') await probe(named.length ? named : SHOPS);
  else if (cmd === 'inbox') await inboxNow();
  else await schedule();
}
