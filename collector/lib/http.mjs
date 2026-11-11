// A polite HTTP client for one shop: one request at a time, a pause between requests, a cookie jar
// (the shop's own session cookies, as any browser keeps them), retries with back-off, and a clear
// stop when the shop says no. No logins and nothing that pretends to be a person.

const UA = process.env.USER_AGENT || 'RestockPrices/1.0 (+https://github.com/d-plenty/restock-prices; weekly price collection for a family app)';

export class ShopBlocked extends Error {
  constructor(shop, why) {
    super(`${shop} stopped answering (${why}). It's tried again at the next run.`);
    this.name = 'ShopBlocked';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  /**
   * @param {string} shop
   * @param {{ delayMs?: number, jitterMs?: number, retries?: number, timeoutMs?: number, fetchImpl?: typeof fetch, sleepImpl?: (ms: number) => Promise<void> }} [o]
   */
  constructor(shop, o = {}) {
    this.shop = shop;
    this.delayMs = o.delayMs ?? Number(process.env.DELAY_MS || 1500);
    this.jitterMs = o.jitterMs ?? 700;
    this.retries = o.retries ?? 4;
    this.timeoutMs = o.timeoutMs ?? 30_000;
    this.fetch = o.fetchImpl ?? globalThis.fetch;
    this.sleep = o.sleepImpl ?? sleep;
    this.cookies = new Map();
    this.last = 0;
    this.requests = 0;
    this.blockedInARow = 0;
    this.verbose = !!o.verbose; // probe: say each request as it goes
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  keepCookies(res) {
    const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of all) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async wait() {
    const gap = this.delayMs + Math.floor(Math.random() * this.jitterMs);
    const since = Date.now() - this.last;
    if (since < gap) await this.sleep(gap - since);
    this.last = Date.now();
  }

  /**
   * One request. Returns { status, text, json() }. Throws ShopBlocked after the shop refuses
   * (403/429, or a page that's clearly a robot check) several times running.
   */
  async get(url, { method = 'GET', headers = {}, body } = {}) {
    let lastWhy = '';
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      await this.wait();
      this.requests++;
      const t0 = Date.now();
      if (this.verbose) console.log(`  ${this.shop}: asking ${url.split('?')[0]}${attempt ? ` (try ${attempt + 1})` : ''}…`);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), this.timeoutMs);
      let res;
      try {
        res = await this.fetch(url, {
          method,
          body,
          redirect: 'follow',
          signal: ctl.signal,
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'en-AU,en;q=0.9',
            ...(this.cookies.size ? { Cookie: this.cookieHeader() } : {}),
            ...headers,
          },
        });
      } catch (e) {
        clearTimeout(t);
        lastWhy = e?.name === 'AbortError' ? 'timed out' : String(e?.cause?.code || e?.message || e);
        if (this.verbose) console.log(`  ${this.shop}: no answer (${lastWhy})`);
        await this.sleep(backoff(attempt));
        continue;
      }
      clearTimeout(t);
      this.keepCookies(res);
      const text = await res.text();
      if (this.verbose) console.log(`  ${this.shop}: HTTP ${res.status}, ${text.length} characters, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      this.onAnswer?.(url, method, res.status, text);
      if (res.status === 403 || res.status === 429 || looksLikeRobotCheck(text)) {
        lastWhy = res.status === 200 ? 'a robot check page' : `HTTP ${res.status}`;
        this.blockedInARow++;
        if (this.blockedInARow >= 3) throw new ShopBlocked(this.shop, lastWhy);
        await this.sleep(backoff(attempt + 2));
        continue;
      }
      if (res.status >= 500) {
        lastWhy = `HTTP ${res.status}`;
        await this.sleep(backoff(attempt));
        continue;
      }
      this.blockedInARow = 0;
      return {
        status: res.status,
        text,
        json() {
          return JSON.parse(text);
        },
      };
    }
    throw new Error(`${this.shop}: ${url.split('?')[0]} failed (${lastWhy}).`);
  }
}

const backoff = (n) => Math.min(120_000, 2_000 * 2 ** n) + Math.floor(Math.random() * 1000);

export function looksLikeRobotCheck(text) {
  const head = String(text).slice(0, 4000);
  return /Incapsula incident|_Incapsula_Resource|queue-it|px-captcha|Access Denied<\/title>|cf-chl|captcha-delivery|Request unsuccessful\. Incapsula/i.test(head);
}
