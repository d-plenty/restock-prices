#!/usr/bin/env node
// Restock prices collector.
//   node collect.mjs             wait and run on schedule (Thursday 1:00 am, retry Friday 1:00 am)
//   node collect.mjs run [shop…] run now (all shops, or the ones named), then publish
//   node collect.mjs probe [shop] fetch one page per shop, save what came back to /data/probe, and say
//                                what it understood. Send those files if a shop stops working.
//   node collect.mjs inbox       fold in what the price helper phone sent (Coles, Woolworths) now, and publish
// With HELPER_KEY set, it also takes uploads from a Restock price helper phone (lib/helper.mjs).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, ShopBlocked } from './lib/http.mjs';
import { detailsFile, fold, latestFile, readGz, split, writeGz, writeHistory } from './lib/store.mjs';
import * as woolworths from './shops/woolworths.mjs';
import * as coles from './shops/coles.mjs';
import * as aldi from './shops/aldi.mjs';
import * as costco from './shops/costco.mjs';
import { HELPER_SHOPS, readInbox, startHelper } from './lib/helper.mjs';

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
  writeShop(shop, state, day, root, statePath);
  const short = prev?.good && seen.size < prev.good * SHORT;
  if (status === 'ok' && short) status = 'short';
  log(`${shop}: ${seen.size} products, ${changed} new prices, ${http.requests} requests, ${status}${helped.count ? ` (and ${helped.count} prices from the price helper phone)` : ''}`);
  return { status, count: seen.size, changed, why, good: status === 'ok' ? seen.size : prev?.good };
}

const dataDirOf = (stateDir) => join(stateDir, '..');

/** The state, its year files and latest/ files, written out. */
function writeShop(shop, state, day, root, statePath) {
  const old = split(state, day);
  writeGz(statePath, state);
  writeHistory(root, shop, old);
  writeGz(join(root, 'latest', `${shop}.json.gz`), latestFile(shop, state));
  writeGz(join(root, 'latest', `${shop}-details.json.gz`), detailsFile(shop, state));
}

/** What the price helper phone sent for this shop, folded in on the days it saw them. */
export function foldInbox(state, shop, dataDir = DATA) {
  if (!HELPER_SHOPS.includes(shop)) return { count: 0, changed: 0 };
  const { products, done } = readInbox(dataDir, shop);
  const byDay = new Map();
  for (const p of products) if (p?.day) byDay.set(p.day, [...(byDay.get(p.day) ?? []), p]);
  let changed = 0;
  for (const d of [...byDay.keys()].sort()) changed += fold(state, byDay.get(d), d);
  done();
  return { count: products.length, changed };
}

/** `inbox`: fold in the price helper's prices now, without asking the shops, and publish. */
async function inboxNow() {
  const r = runs();
  for (const shop of HELPER_SHOPS.filter((s) => SHOPS.includes(s))) {
    const statePath = join(STATE, `${shop}.json.gz`);
    const state = readGz(statePath, { products: {} });
    const { count, changed } = foldInbox(state, shop);
    if (!count) {
      log(`${shop}: nothing from the price helper phone yet`);
      continue;
    }
    writeShop(shop, state, today(), OUT, statePath);
    log(`${shop}: ${count} prices from the price helper phone, ${changed} new`);
  }
  try {
    publish(r);
  } catch (e) {
    log(`publish failed: ${e.message}`);
  }
}

function summary(r) {
  const lines = ['# Last run', '', '| Shop | When | Products | New prices | Result |', '|---|---|---|---|---|'];
  for (const s of Object.keys(SHOP_CODE)) {
    const x = r[s];
    if (x) lines.push(`| ${s} | ${x.at} | ${x.count} | ${x.changed} | ${x.status}${x.why ? `: ${x.why.replace(/\|/g, '/')}` : ''} |`);
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
  for (const sub of ['latest', 'history']) if (existsSync(join(OUT, sub))) cpSync(join(OUT, sub), join(dir, sub), { recursive: true });
  cpSync(join(OUT, 'STATUS.md'), join(dir, 'STATUS.md'));
  git('add', '-A', 'latest', 'history', 'STATUS.md');
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
async function schedule() {
  startHelper({ dataDir: DATA, today, log });
  log(`waiting: ${SHOPS.join(', ')} every ${RUN_DAY} at ${RUN_TIME}, retry ${RETRY_DAY} for any shop that failed or came back short`);
  let done = '';
  for (;;) {
    const now = new Date();
    const hm = now.toTimeString().slice(0, 5);
    const day = DAYS[now.getDay()];
    const key = `${today()} ${day}`;
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
