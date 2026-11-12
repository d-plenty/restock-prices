// Feedback from the Restock app (Restock 0.9.13). Settings → Feedback sends a message here:
// what it's about, the message, up to 3 screenshots, diagnostics (on unless the person turned them
// off) and an email only if they want a reply. Each one is kept in its own folder:
//   /data/feedback/<when>-<id>/feedback.json, shot-1.jpg, …, done (when marked done)
// and read at /feedback/inbox, behind FEEDBACK_PASSWORD (the browser asks for it; any user name).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const KINDS = { wrong: "Something's wrong", idea: 'An idea', like: 'Something I like', other: 'Other' };
const MAX_BODY = 8 * 1024 * 1024;
const MAX_SHOT = 1_500_000;
const PER_PHONE_A_DAY = 5;
const PER_ADDRESS_A_DAY = 30;
const IMAGE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** True when the bytes really are that kind of picture. */
export function isImage(type, buf) {
  if (type === 'image/jpeg') return buf[0] === 0xff && buf[1] === 0xd8;
  if (type === 'image/png') return buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/webp') return buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  return false;
}

/** A message as the app sent it, checked and tidied: { item, shots } or { error }. */
export function cleanFeedback(body) {
  if (!body || body.format !== 'restock-feedback') return { error: 'not Restock feedback' };
  const message = str(body.message, 5000);
  if (!message) return { error: 'the message is empty' };
  const shots = [];
  for (const s of Array.isArray(body.screenshots) ? body.screenshots.slice(0, 3) : []) {
    const ext = IMAGE[s?.type];
    if (!ext || typeof s.data !== 'string') continue;
    const buf = Buffer.from(s.data, 'base64');
    if (buf.length > MAX_SHOT || !isImage(s.type, buf)) continue;
    shots.push({ ext, buf });
  }
  let diagnostics;
  if (body.diagnostics && typeof body.diagnostics === 'object') {
    const text = JSON.stringify(body.diagnostics);
    diagnostics = text.length <= 300_000 ? body.diagnostics : { cut: 'too big to keep', size: text.length };
  }
  const email = str(body.email, 200);
  return {
    item: {
      kind: KINDS[body.kind] ? body.kind : 'other',
      message,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined,
      app: str(body.app, 40),
      platform: ['android', 'web', 'iphone'].includes(body.platform) ? body.platform : undefined,
      device: str(body.device, 120),
      screen: str(body.screen, 80),
      diagnostics,
    },
    shots,
  };
}

/** The inbox's messages, newest first. */
export function listFeedback(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[\w-]+$/.test(n) && existsSync(join(dir, n, 'feedback.json')))
    .sort()
    .reverse()
    .map((id) => ({ id, ...JSON.parse(readFileSync(join(dir, id, 'feedback.json'), 'utf8')), done: existsSync(join(dir, id, 'done')) }));
}

export function feedbackHandler({ dataDir, password = process.env.FEEDBACK_PASSWORD, log = console.log, now = () => new Date() }) {
  const dir = join(dataDir, 'feedback');
  const counts = new Map(); // "<day> <who>" → how many today
  const want = password ? Buffer.from(password) : undefined;
  const allowed = (req) => {
    if (!want) return false;
    const m = /^Basic (.+)$/.exec(String(req.headers.authorization ?? ''));
    if (!m) return false;
    const got = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8').replace(/^[^:]*:/, ''));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  const page = (res, status, title, body) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.45 system-ui,sans-serif;margin:0 auto;max-width:860px;padding:16px;color:#1b2333;background:#f6f3ec}a{color:#0a6b3d}
.m{background:#fff;border:1px solid #e2dccd;border-radius:12px;padding:12px 14px;margin:10px 0;display:block;text-decoration:none;color:inherit}.m.done{opacity:.55}
.k{font-weight:600}.s{color:#5b6475;font-size:14px}pre{white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e2dccd;border-radius:8px;padding:10px;font-size:13px}
img{max-width:100%;border-radius:8px;border:1px solid #e2dccd;margin:6px 0}button{font:inherit;padding:10px 16px;border-radius:10px;border:1px solid #0a6b3d;background:#0a6b3d;color:#fff}
@media (prefers-color-scheme:dark){body{background:#12161f;color:#e7e9ee}.m,pre{background:#1b2130;border-color:#2c3447}.s{color:#9aa3b5}a{color:#5fd39a}}</style></head><body>${body}</body></html>`);
  };
  const ask = (res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Restock feedback", charset="UTF-8"', 'Content-Type': 'text/plain' });
    res.end(want ? 'The feedback inbox needs its password.' : 'Set FEEDBACK_PASSWORD in the container (Dockge .env) to read the inbox.');
  };

  return function handle(req, res, path) {
    if (path === '/feedback' && req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
      res.end();
      return true;
    }
    if (path === '/feedback' && req.method === 'POST') {
      const who = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
      let size = 0;
      const parts = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          json(res, 413, { error: 'too big: send fewer or smaller screenshots' });
          req.destroy();
        } else parts.push(c);
      });
      req.on('end', () => {
        if (res.writableEnded) return;
        let body;
        try {
          body = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
          return json(res, 400, { error: 'not JSON' });
        }
        const day = now().toISOString().slice(0, 10);
        const phone = str(body?.install, 64) ?? 'unknown';
        const n1 = counts.get(`${day} p:${phone}`) ?? 0;
        const n2 = counts.get(`${day} a:${who}`) ?? 0;
        if (n1 >= PER_PHONE_A_DAY || n2 >= PER_ADDRESS_A_DAY) return json(res, 429, { error: 'That’s a lot of feedback for one day. Please try again tomorrow.' });
        const { item, shots, error } = cleanFeedback(body);
        if (error) return json(res, 400, { error });
        counts.set(`${day} p:${phone}`, n1 + 1);
        counts.set(`${day} a:${who}`, n2 + 1);
        if (counts.size > 5000) for (const k of counts.keys()) if (!k.startsWith(day)) counts.delete(k);
        const at = now().toISOString();
        const id = `${at.replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
        mkdirSync(join(dir, id), { recursive: true });
        const names = shots.map((s, i) => {
          const name = `shot-${i + 1}.${s.ext}`;
          writeFileSync(join(dir, id, name), s.buf);
          return name;
        });
        writeFileSync(join(dir, id, 'feedback.json'), JSON.stringify({ at, ...item, screenshots: names }, null, 1));
        log(`feedback: ${KINDS[item.kind]} from ${item.platform ?? 'a phone'} ${item.app ?? ''}${names.length ? `, ${names.length} screenshots` : ''}`);
        json(res, 200, { ok: true, id });
      });
      return true;
    }
    if (!path.startsWith('/feedback/inbox')) return false;
    if (!allowed(req)) {
      ask(res);
      return true;
    }
    const rest = path.slice('/feedback/inbox'.length).split('/').filter(Boolean);
    if (!rest.length) {
      const all = listFeedback(dir);
      const open = all.filter((x) => !x.done).length;
      const rows = all
        .map(
          (x) => `<a class="m${x.done ? ' done' : ''}" href="/feedback/inbox/${esc(x.id)}"><span class="k">${esc(KINDS[x.kind] ?? x.kind)}</span>${x.done ? ' · done' : ''}
<div>${esc(x.message.slice(0, 240))}${x.message.length > 240 ? '…' : ''}</div>
<div class="s">${esc(new Date(x.at).toLocaleString('en-AU', { timeZone: process.env.TZ || 'Australia/Brisbane' }))} · ${esc(x.platform ?? '')} ${esc(x.app ?? '')}${x.screenshots?.length ? ` · ${x.screenshots.length} screenshot${x.screenshots.length > 1 ? 's' : ''}` : ''}${x.email ? ' · wants a reply' : ''}</div></a>`,
        )
        .join('');
      page(res, 200, 'Restock feedback', `<h1>Restock feedback</h1><p class="s">${all.length} messages, ${open} not done yet.</p>${rows || '<p>Nothing yet.</p>'}`);
      return true;
    }
    const id = rest[0];
    if (!/^[\w-]+$/.test(id) || !existsSync(join(dir, id, 'feedback.json'))) {
      page(res, 404, 'Not found', '<p>That message isn’t here. <a href="/feedback/inbox">Back to the inbox</a></p>');
      return true;
    }
    if (rest[1] && /^shot-[1-3]\.(jpg|png|webp)$/.test(rest[1]) && existsSync(join(dir, id, rest[1]))) {
      const ext = rest[1].split('.').pop();
      res.writeHead(200, { 'Content-Type': ext === 'jpg' ? 'image/jpeg' : `image/${ext}`, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      res.end(readFileSync(join(dir, id, rest[1])));
      return true;
    }
    if (rest[1] === 'done' && req.method === 'POST') {
      const f = join(dir, id, 'done');
      if (existsSync(f)) rmSync(f);
      else writeFileSync(f, now().toISOString());
      res.writeHead(303, { Location: `/feedback/inbox/${id}` });
      res.end();
      return true;
    }
    const x = { id, ...JSON.parse(readFileSync(join(dir, id, 'feedback.json'), 'utf8')), done: existsSync(join(dir, id, 'done')) };
    page(
      res,
      200,
      'Restock feedback',
      `<p><a href="/feedback/inbox">← All feedback</a></p><h1>${esc(KINDS[x.kind] ?? x.kind)}</h1>
<p class="s">${esc(new Date(x.at).toLocaleString('en-AU', { timeZone: process.env.TZ || 'Australia/Brisbane' }))} · ${esc(x.platform ?? '')} · Restock ${esc(x.app ?? '?')} · ${esc(x.device ?? '')}${x.screen ? ` · sent from ${esc(x.screen)}` : ''}</p>
<pre>${esc(x.message)}</pre>
${x.email ? `<p>Wants a reply: <a href="mailto:${esc(x.email)}">${esc(x.email)}</a></p>` : '<p class="s">No email left: they didn’t ask for a reply.</p>'}
${(x.screenshots ?? []).map((n) => `<a href="/feedback/inbox/${esc(id)}/${esc(n)}"><img src="/feedback/inbox/${esc(id)}/${esc(n)}" alt="Screenshot"></a>`).join('')}
<h2>Diagnostics</h2>${x.diagnostics ? `<pre>${esc(JSON.stringify(x.diagnostics, null, 2))}</pre>` : '<p class="s">They chose not to attach diagnostics.</p>'}
<form method="post" action="/feedback/inbox/${esc(id)}/done"><button>${x.done ? 'Mark as not done' : 'Mark as done'}</button></form>`,
    );
    return true;
  };
}
