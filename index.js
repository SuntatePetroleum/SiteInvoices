// Sunstate Petroleum — Site Invoices & Fuel Dockets.
// One Cloudflare Worker: serves the app and a small JSON API.
// Photos and their details are kept in an R2 bucket (binding INVOICES):
//
//   config/sites.json                                 site list (+ old Fuel Dockets location names)
//   config/suppliers.json                             invoice supplier names seen (for suggestions)
//   invoices/<site>/<YYYY-MM>/<id>/p1.jpg, p2.jpg …   supplier invoices, one JPEG per page
//   dockets/<site>/<YYYY-MM>/<id>/p1.jpg, p2.jpg …    fuel delivery dockets, one JPEG per page
//   …/<id>/meta.json                                  the record's details; also copied into the
//                                                     object's custom metadata so a month can be
//                                                     listed in one call
//
// Invoices and dockets share one record shape. For a docket, `invoiceNo` holds the docket / bill
// of lading number and `invoiceDate` the delivery date, and `also` lists the other sites the same
// docket was filed under (a split load).
//
// The old Fuel Dockets app (DOCKETS_URL, or a DOCKETS service binding in the same account) is only
// used to import its existing dockets once, and as a fallback for reading photos with Claude when
// this Worker has no ANTHROPIC_API_KEY secret of its own.

import UI_HTML from './ui.html';
import SYMBOL_PNG from './symbol-256.png';
import SYMBOL_LG_PNG from './symbol-512.png';
import TOUCH_ICON_PNG from './apple-touch-icon.png';
import ICON_192_PNG from './icon-192.png';
import ICON_512_PNG from './icon-512.png';
import FAVICON_PNG from './favicon-64.png';

const DEFAULT_DOCKETS_URL = 'https://fueldockets.jaidenbanks88.workers.dev';
const SITES_KEY = 'config/sites.json';
const SUPPLIERS_KEY = 'config/suppliers.json';
const ROOTS = { invoice: 'invoices/', docket: 'dockets/' };
const NOUN = { invoice: 'invoice', docket: 'docket' };

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const INV_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OLD_DATE_RE = /^(0[1-9]|[12]\d|3[01])-(0[1-9]|1[0-2])-(\d{4})$/; // Fuel Dockets: DD-MM-YYYY
const MAX_PAGES = 30;
const MAX_PAGE_BYTES = 15 * 1024 * 1024;
const MAX_AUTOFILL_BYTES = 12 * 1024 * 1024;
const MAX_EXTRA_SITES = 5; // a split load can be filed under up to 6 sites
const RECENT_MONTHS = 3; // office "new" counts look back this many months
const OLD_SUPPLIERS = { IOR: 'IOR', Viva: 'Viva Energy', Unknown: 'Other' };

const ASSETS = {
  '/assets/symbol.png': SYMBOL_PNG,
  '/assets/symbol-lg.png': SYMBOL_LG_PNG,
  '/apple-touch-icon.png': TOUCH_ICON_PNG,
  '/assets/icon-192.png': ICON_192_PNG,
  '/assets/icon-512.png': ICON_512_PNG,
  '/favicon.png': FAVICON_PNG,
};

const MANIFEST = {
  name: 'Sunstate Site Invoices',
  short_name: 'SSP Invoices',
  start_url: '/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#ffffff',
  icons: [
    { src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png' },
  ],
};

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e && e.stack ? e.stack : e);
      return json({ error: 'Something went wrong on the server. Please try again.' }, 500);
    }
  },
};

/* ----------------------------------------------------------------- helpers */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readBody(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) fail(413, 'Request is too large.');
  try { return text ? JSON.parse(text) : {}; } catch { fail(400, 'Request was not valid JSON.'); }
}

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanTotal(v) {
  const s = String(v ?? '').replace(/[$,\s]/g, '');
  if (!s) return '';
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n < 1e9 ? n.toFixed(2) : '';
}

function cleanDate(v) {
  const s = String(v ?? '').trim();
  return DATE_RE.test(s) ? s : '';
}

const kindOf = (v) => (v === 'docket' ? 'docket' : 'invoice');

// Queensland has no daylight saving, so Brisbane is always UTC+10.
function bneNow() {
  const iso = new Date(Date.now() + 10 * 3600e3).toISOString();
  return {
    date: iso.slice(0, 10),
    month: iso.slice(0, 7),
    stamp: iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 19).replace(/:/g, ''),
    local: iso.slice(0, 19) + '+10:00',
  };
}

function recentMonths(n) {
  const [y, m] = bneNow().month.split('-').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

function rand(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'site';
}

const normKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function checkSiteId(v) { if (!SITE_RE.test(String(v || ''))) fail(400, 'Unknown site.'); return v; }
function checkMonth(v) { if (!MONTH_RE.test(String(v || ''))) fail(400, 'Bad month.'); return v; }
function checkInvId(v) { if (!INV_RE.test(String(v || ''))) fail(400, 'Bad record id.'); return v; }

const recPrefix = (kind, site, month, id) => `${ROOTS[kind]}${site}/${month}/${id}/`;
const metaKey = (kind, site, month, id) => recPrefix(kind, site, month, id) + 'meta.json';
const pageKey = (kind, site, month, id, n) => recPrefix(kind, site, month, id) + `p${n}.jpg`;

function safeFilename(s) {
  return String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}

/* -------------------------------------------------------------------- auth */
// Optional passcodes, set as Worker secrets: OFFICE_PIN (office screens) and STAFF_PIN (uploads).
// When one is set, a correct entry leaves a signed cookie on that device. Changing the secret
// signs every device out. An office cookie also allows staff actions.

async function roleToken(role, pin) { return sha256Hex(`ssp-site-invoices:${role}:${pin}`); }

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

async function hasRole(request, env, role) {
  if (role === 'staff') {
    if (!env.STAFF_PIN) return true;
    const c = getCookie(request, 'ssp_staff');
    if (c && (await safeEqual(c, await roleToken('staff', env.STAFF_PIN)))) return true;
    return hasRole(request, env, 'office-strict');
  }
  // office, or office-strict (an office cookie when a staff PIN is set)
  if (!env.OFFICE_PIN) return role === 'office';
  const c = getCookie(request, 'ssp_office');
  return !!c && (await safeEqual(c, await roleToken('office', env.OFFICE_PIN)));
}

async function requireRole(request, env, role) {
  if (!(await hasRole(request, env, role))) {
    fail(401, role === 'office' ? 'Enter the office passcode.' : 'Enter the site PIN.');
  }
}

async function handleAuth(request, env) {
  const body = await readBody(request);
  const role = body.role === 'office' ? 'office' : 'staff';
  const pin = role === 'office' ? env.OFFICE_PIN : env.STAFF_PIN;
  if (!pin) return json({ ok: true });
  if (typeof body.pin !== 'string' || !(await safeEqual(body.pin.trim(), String(pin).trim()))) {
    await sleep(800); // slows down guessing
    fail(401, role === 'office' ? 'That passcode is not right.' : 'That PIN is not right.');
  }
  const maxAge = role === 'office' ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 400;
  const token = await roleToken(role, String(pin).trim());
  return json({ ok: true }, 200, {
    'set-cookie': `ssp_${role}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
  });
}

/* ------------------------------------------------------------------ storage */

async function readJSON(env, key, fallback) {
  const obj = await env.INVOICES.get(key);
  if (!obj) return fallback;
  try { return await obj.json(); } catch { return fallback; }
}

async function writeJSON(env, key, value) {
  await env.INVOICES.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });
}

async function getSites(env) {
  const data = await readJSON(env, SITES_KEY, { sites: [] });
  return Array.isArray(data.sites) ? data.sites : [];
}

async function saveSites(env, sites) { await writeJSON(env, SITES_KEY, { sites }); }

async function requireSite(env, siteId, { allowArchived = false, sites } = {}) {
  checkSiteId(siteId);
  const site = (sites || (await getSites(env))).find((s) => s.id === siteId);
  if (!site || (site.archived && !allowArchived)) fail(404, 'That site is not set up. Ask the office.');
  return site;
}

const META_FIELDS = ['kind', 'supplier', 'invoiceNo', 'invoiceDate', 'total', 'note', 'by', 'pages', 'bytes', 'uploadedAt', 'status', 'processedAt', 'also', 'source'];

function recordFromListed(obj) {
  const [root, site, month, id] = obj.key.split('/');
  const m = obj.customMetadata || {};
  return {
    kind: root === 'dockets' ? 'docket' : 'invoice',
    site, month, id,
    supplier: m.supplier || '', invoiceNo: m.invoiceNo || '', invoiceDate: m.invoiceDate || '',
    total: m.total || '', note: m.note || '', by: m.by || '',
    pages: Number(m.pages) || 0, bytes: Number(m.bytes) || 0,
    uploadedAt: m.uploadedAt || '', status: m.status === 'processed' ? 'processed' : 'new',
    processedAt: m.processedAt || '', also: m.also || '', source: m.source || '',
  };
}

async function putMeta(env, rec) {
  rec.kind = kindOf(rec.kind);
  const customMetadata = {};
  for (const f of META_FIELDS) customMetadata[f] = String(rec[f] ?? '').slice(0, 300);
  await env.INVOICES.put(metaKey(rec.kind, rec.site, rec.month, rec.id), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata,
  });
}

async function getMeta(env, kind, site, month, id) {
  const obj = await env.INVOICES.get(metaKey(kind, site, month, id));
  if (!obj) fail(404, `That ${NOUN[kind]} was not found. It may have been deleted.`);
  const rec = await obj.json();
  rec.kind = kind;
  return rec;
}

async function listAll(env, options) {
  const out = { objects: [], prefixes: [] };
  let cursor;
  do {
    const res = await env.INVOICES.list({ ...options, cursor });
    out.objects.push(...res.objects);
    if (res.delimitedPrefixes) out.prefixes.push(...res.delimitedPrefixes);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

async function listMonth(env, kind, site, month) {
  const { objects } = await listAll(env, { prefix: `${ROOTS[kind]}${site}/${month}/`, include: ['customMetadata'] });
  return objects.filter((o) => o.key.endsWith('/meta.json')).map(recordFromListed).sort((a, b) => b.id.localeCompare(a.id));
}

async function listSiteMonths(env, kind, site) {
  const { prefixes } = await listAll(env, { prefix: `${ROOTS[kind]}${site}/`, delimiter: '/' });
  return prefixes.map((p) => p.split('/')[2]).filter((m) => MONTH_RE.test(m)).sort().reverse();
}

async function rememberSupplier(env, name) {
  const key = name.toLowerCase();
  if (!key) return;
  const data = await readJSON(env, SUPPLIERS_KEY, { suppliers: {} });
  const all = data.suppliers && typeof data.suppliers === 'object' ? data.suppliers : {};
  const prev = all[key] || { count: 0 };
  all[key] = { name, count: prev.count + 1, last: bneNow().date };
  // Keep the file small: drop the least used once there are lots.
  const entries = Object.entries(all);
  if (entries.length > 400) {
    entries.sort((a, b) => b[1].count - a[1].count);
    await writeJSON(env, SUPPLIERS_KEY, { suppliers: Object.fromEntries(entries.slice(0, 300)) });
  } else {
    await writeJSON(env, SUPPLIERS_KEY, { suppliers: all });
  }
}

/* ------------------------------------------------------- old fuel dockets app */

function docketsBound(env) { return !!(env.DOCKETS && typeof env.DOCKETS.fetch === 'function') || !!env.DOCKETS_URL; }

async function docketsFetch(env, path, init) {
  if (env.DOCKETS && typeof env.DOCKETS.fetch === 'function') return env.DOCKETS.fetch(new Request('https://fueldockets' + path, init));
  const base = String(env.DOCKETS_URL || DEFAULT_DOCKETS_URL).replace(/\/+$/, '');
  return fetch(base + path, init);
}

async function docketsJSON(env, path) {
  let res;
  try { res = await docketsFetch(env, path); } catch { fail(502, 'Could not reach the old Fuel Dockets app.'); }
  if (!res.ok) fail(502, 'The old Fuel Dockets app did not answer (' + res.status + ').');
  try { return await res.json(); } catch { fail(502, 'The old Fuel Dockets app sent something unexpected.'); }
}

/* ------------------------------------------------------------------- routes */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    return new Response(UI_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      },
    });
  }
  if (method === 'GET' && ASSETS[path]) {
    return new Response(ASSETS[path], { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
  }
  if (method === 'GET' && path === '/manifest.webmanifest') {
    return new Response(JSON.stringify(MANIFEST), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' } });
  }
  if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });
  if (!env.INVOICES) fail(500, 'Storage is not connected yet: add the INVOICES R2 bucket (see the README).');

  let parts;
  try { parts = path.slice(5).split('/').filter(Boolean).map(decodeURIComponent); } catch { fail(400, 'Bad address.'); }
  const q = url.searchParams;
  const qKind = kindOf(q.get('kind'));

  // ---- open to everyone
  if (path === '/api/config' && method === 'GET') return getConfig(request, env);
  if (path === '/api/auth' && method === 'POST') return handleAuth(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': 'ssp_office=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }

  // ---- site staff and drivers
  if (parts[0] === 'staff') {
    await requireRole(request, env, 'staff');
    const action = parts[1];
    if (action === 'suppliers' && method === 'GET') return staffSuppliers(env);
    if (action === 'recent' && method === 'GET') return staffRecent(env, q.get('site'));
    if (action === 'start' && method === 'POST') return staffStart(request, env);
    if (action === 'page' && method === 'PUT' && parts.length === 6) return staffPage(request, env, qKind, parts[2], parts[3], parts[4], parts[5]);
    if (action === 'finish' && method === 'POST') return staffFinish(request, env, ctx);
    if (action === 'autofill' && method === 'POST') return staffAutofill(request, env);
    fail(404, 'Not found.');
  }

  // ---- office
  if (parts[0] === 'office') {
    await requireRole(request, env, 'office');
    const action = parts[1];
    if (action === 'overview' && method === 'GET') return officeOverview(env);
    if (action === 'months' && method === 'GET') return officeMonths(env, qKind, q.get('site'));
    if (action === 'records' && method === 'GET') return officeRecords(env, qKind, q.get('site'), q.get('month'));
    if (action === 'page' && method === 'GET' && parts.length === 6) return officePage(env, qKind, parts[2], parts[3], parts[4], parts[5], q.get('download'));
    if (action === 'update' && method === 'POST') return officeUpdate(request, env);
    if (action === 'status' && method === 'POST') return officeBulkStatus(request, env);
    if (action === 'delete' && method === 'POST') return officeDelete(request, env);
    if (action === 'sites' && method === 'POST') return officeSites(request, env);
    if (action === 'import') {
      if (parts[2] === 'plan' && method === 'GET') return importPlan(env);
      if (parts[2] === 'one' && method === 'POST') return importOne(request, env);
    }
    fail(404, 'Not found.');
  }

  fail(404, 'Not found.');
}

/* ------------------------------------------------------------------ config */

function autofillOn(env) {
  if (String(env.AUTOFILL || '').toLowerCase() === 'off') return false;
  return !!env.ANTHROPIC_API_KEY || docketsBound(env);
}

async function getConfig(request, env) {
  const sites = await getSites(env);
  const [staffOk, officeOk] = await Promise.all([hasRole(request, env, 'staff'), hasRole(request, env, 'office')]);
  return json({
    sites: sites.map((s) => ({ id: s.id, name: s.name, archived: !!s.archived })),
    staffPin: !!env.STAFF_PIN,
    officePin: !!env.OFFICE_PIN,
    staffOk,
    officeOk,
    oldDockets: docketsBound(env),
    autofill: autofillOn(env),
    autofillOwnKey: !!env.ANTHROPIC_API_KEY,
    today: bneNow().date,
  });
}

/* ------------------------------------------------------------------- staff */

async function staffSuppliers(env) {
  const data = await readJSON(env, SUPPLIERS_KEY, { suppliers: {} });
  const list = Object.values(data.suppliers || {}).sort((a, b) => b.count - a.count).slice(0, 150).map((s) => s.name);
  return json({ suppliers: list });
}

async function staffRecent(env, siteId) {
  await requireSite(env, siteId);
  const [cur, prev] = recentMonths(2);
  const lists = await Promise.all([listMonth(env, 'invoice', siteId, cur), listMonth(env, 'docket', siteId, cur)]);
  let recs = lists.flat();
  if (recs.length < 8) {
    const older = await Promise.all([listMonth(env, 'invoice', siteId, prev), listMonth(env, 'docket', siteId, prev)]);
    recs = recs.concat(older.flat());
  }
  recs.sort((a, b) => b.id.localeCompare(a.id));
  const items = recs.filter((r) => r.source !== 'fueldockets').slice(0, 8).map((r) => ({
    kind: r.kind, id: r.id, supplier: r.supplier, invoiceNo: r.invoiceNo, pages: r.pages, by: r.by, uploadedAt: r.uploadedAt, status: r.status,
  }));
  return json({ items });
}

async function staffStart(request, env) {
  const b = await readBody(request);
  const kind = kindOf(b.kind);
  const sites = await getSites(env);
  const site = await requireSite(env, b.site, { sites });
  const now = bneNow();
  const id = `${now.stamp}-${rand(4)}`;

  // Has this invoice / docket number already come through recently? For a docket, check every
  // site it is going to, since a driver and the site staff may both send the same one.
  const check = [site];
  if (kind === 'docket' && Array.isArray(b.alsoSites)) {
    for (const sid of b.alsoSites.slice(0, MAX_EXTRA_SITES)) {
      const s = sites.find((x) => x.id === sid && !x.archived);
      if (s && !check.includes(s)) check.push(s);
    }
  }
  let duplicate = null;
  const ref = normKey(b.invoiceNo);
  if (ref.length >= 3) {
    const supplier = normKey(b.supplier);
    search: for (const s of check) {
      for (const m of recentMonths(2)) {
        const recs = await listMonth(env, kind, s.id, m);
        const hit = recs.find((r) => normKey(r.invoiceNo) === ref && (!supplier || !normKey(r.supplier) || normKey(r.supplier) === supplier));
        if (hit) { duplicate = { kind, siteName: s.name, supplier: hit.supplier, invoiceNo: hit.invoiceNo, by: hit.by, uploadedAt: hit.uploadedAt }; break search; }
      }
    }
  }
  return json({ id, month: now.month, duplicate });
}

async function staffPage(request, env, kind, siteId, month, id, n) {
  checkSiteId(siteId); checkMonth(month); checkInvId(id);
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) fail(400, `Too many pages for one ${NOUN[kind]}.`);
  if (!/^image\/jpeg\b/i.test(request.headers.get('content-type') || '')) fail(415, 'Photos must be sent as JPEG.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_PAGE_BYTES) fail(413, 'That photo is too large.');
  await requireSite(env, siteId);
  if (await env.INVOICES.head(metaKey(kind, siteId, month, id))) fail(409, `This ${NOUN[kind]} has already been sent.`);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) fail(400, 'The photo was empty. Please try again.');
  if (buf.byteLength > MAX_PAGE_BYTES) fail(413, 'That photo is too large.');
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0xff || head[1] !== 0xd8) fail(415, 'That file is not a JPEG photo.');
  await env.INVOICES.put(pageKey(kind, siteId, month, id, page), buf, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ ok: true, page, bytes: buf.byteLength });
}

async function staffFinish(request, env, ctx) {
  const b = await readBody(request);
  const kind = kindOf(b.kind);
  const sites = await getSites(env);
  const site = await requireSite(env, b.site, { sites });
  const month = checkMonth(b.month);
  const id = checkInvId(b.id);
  const pages = Number(b.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) fail(400, 'Add at least one photo.');

  const existing = await env.INVOICES.get(metaKey(kind, site.id, month, id));
  if (existing) { const rec = await existing.json(); rec.kind = kind; return json({ record: rec, already: true }); }

  const supplier = clean(b.supplier, 80);
  const by = clean(b.by, 40);
  if (!supplier) fail(400, 'Enter the supplier.');
  if (!by) fail(400, 'Enter your name.');

  // A docket for a split load is filed under every site it was delivered to.
  const extras = [];
  if (kind === 'docket' && Array.isArray(b.alsoSites)) {
    for (const sid of b.alsoSites) {
      if (sid === site.id || extras.some((s) => s.id === sid)) continue;
      extras.push(await requireSite(env, sid, { sites }));
    }
    if (extras.length > MAX_EXTRA_SITES) fail(400, `A docket can be filed under at most ${MAX_EXTRA_SITES + 1} sites.`);
  }

  // Every page must be there, and any pages left over from an earlier attempt are removed.
  const { objects } = await listAll(env, { prefix: recPrefix(kind, site.id, month, id) });
  const sizes = {};
  for (const o of objects) {
    const m = /\/p(\d+)\.jpg$/.exec(o.key);
    if (m) sizes[Number(m[1])] = o.size;
  }
  let bytes = 0;
  for (let i = 1; i <= pages; i++) {
    if (!sizes[i]) fail(400, `Photo ${i} did not upload. Tap Try again.`);
    bytes += sizes[i];
  }
  const extra = Object.keys(sizes).map(Number).filter((i) => i > pages).map((i) => pageKey(kind, site.id, month, id, i));
  if (extra.length) await env.INVOICES.delete(extra);

  const group = [site, ...extras];
  const alsoFor = (s) => group.filter((x) => x.id !== s.id).map((x) => x.name).join(', ');
  const base = {
    kind,
    month,
    supplier,
    invoiceNo: clean(b.invoiceNo, 40),
    invoiceDate: cleanDate(b.invoiceDate),
    total: kind === 'invoice' ? cleanTotal(b.total) : '',
    note: clean(b.note, 300),
    by,
    pages, bytes,
    uploadedAt: bneNow().local,
    status: 'new',
    processedAt: '',
    source: '',
  };

  // Copies for the other sites first (with ids derived from this one, so a retry after a dropped
  // connection fills in what is missing rather than making doubles), then this site's record last.
  for (const s of extras) {
    const copyId = id.slice(0, 16) + (await sha256Hex(id + '|' + s.id)).slice(0, 4); // keeps "YYYYMMDD-HHMMSS-"
    if (await env.INVOICES.head(metaKey(kind, s.id, month, copyId))) continue;
    for (let i = 1; i <= pages; i++) {
      const src = await env.INVOICES.get(pageKey(kind, site.id, month, id, i));
      await env.INVOICES.put(pageKey(kind, s.id, month, copyId, i), await src.arrayBuffer(), { httpMetadata: { contentType: 'image/jpeg' } });
    }
    await putMeta(env, { ...base, site: s.id, id: copyId, also: alsoFor(s) });
  }
  const rec = { ...base, site: site.id, id, also: alsoFor(site) };
  await putMeta(env, rec);

  if (kind === 'invoice') {
    const remember = rememberSupplier(env, supplier).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(remember); else await remember;
  }
  return json({ record: rec, copies: extras.length });
}

/* ---------------------------------------------------------------- auto-fill */
// Reads the photos with Claude and returns the details it found. Uses this Worker's own
// ANTHROPIC_API_KEY secret when there is one, otherwise the old Fuel Dockets app's /analyse proxy.

const INVOICE_PROMPT = 'These photos are the pages of one supplier invoice (or delivery docket) received at an Australian service station. ' +
  'Read them and return the details as JSON only, with no other text:\n' +
  '{"supplier":"trading name of the business that issued the invoice, short and without Pty Ltd","invoiceNo":"invoice or document number","invoiceDate":"YYYY-MM-DD","total":"total amount payable including GST as a plain number, e.g. 1234.50"}\n' +
  'The supplier is the company that sent the invoice, not the customer (the customer is the service station). Use null for anything you cannot read clearly. Dates on Australian invoices are day/month/year.';

function docketPrompt(siteNames) {
  return 'These photos are the pages of one fuel delivery docket (bill of lading) for a delivery by tanker to Australian service stations. ' +
    'Read them and return the details as JSON only, with no other text:\n' +
    '{"supplier":"IOR" or "Viva" or "Other","otherSupplier":"name of the fuel supplier if Other, else null","locations":["delivery site name"],"docketNo":"docket, bill of lading or delivery number","deliveryDate":"YYYY-MM-DD"}\n' +
    'Where to find the delivery location: IOR bill of lading — handwritten middle-left. Sunstate docket — the Customer Address field. Viva Energy documents — handwritten top-right or in the right margin. A docket can list more than one site when a load is split.\n' +
    'Supplier rules: IOR logo = IOR. Viva Energy Australia logo = Viva. Sunstate docket with Terminal SSP = IOR. Terminal VIVA or NCPT written = Viva. Anything else = Other.\n' +
    (siteNames.length ? 'The delivery sites are: ' + siteNames.join('; ') + '. Use these exact names in "locations" for the sites you can identify; spelling on the docket may differ.\n' : '') +
    'Use null (or an empty list) for anything you cannot read clearly. Dates are day/month/year on Australian documents.';
}

function extractJSON(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

async function staffAutofill(request, env) {
  if (!autofillOn(env)) fail(501, 'Reading photos automatically is turned off.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_AUTOFILL_BYTES) fail(413, 'Photos are too large to read.');
  const b = await readBody(request, MAX_AUTOFILL_BYTES);
  const kind = kindOf(b.kind);
  const images = (Array.isArray(b.images) ? b.images : []).slice(0, 3).filter((x) => typeof x === 'string' && /^[A-Za-z0-9+/=]+$/.test(x));
  if (!images.length) fail(400, 'No photos to read.');
  const sites = (await getSites(env)).filter((s) => !s.archived);
  const prompt = kind === 'docket' ? docketPrompt(sites.map((s) => s.name)) : INVOICE_PROMPT;
  const body = JSON.stringify({
    model: String(env.AUTOFILL_MODEL || 'claude-sonnet-4-6'),
    max_tokens: 400,
    messages: [{
      role: 'user',
      content: images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })).concat([{ type: 'text', text: prompt }]),
    }],
  });
  let res;
  try {
    if (env.ANTHROPIC_API_KEY) {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body,
      });
    } else {
      res = await docketsFetch(env, '/analyse', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    }
  } catch {
    fail(502, 'Could not reach the reader.');
  }
  if (!res.ok) fail(502, 'The reader could not read these photos (' + res.status + ').');
  const data = await res.json().catch(() => ({}));
  const text = (data.content || []).map((c) => c.text || '').join('');
  const out = extractJSON(text);

  if (kind === 'docket') {
    const sup = String(out.supplier || '').toLowerCase();
    const supplier = sup.startsWith('ior') ? 'IOR' : sup.startsWith('viva') ? 'Viva Energy' : out.supplier ? 'Other' : '';
    const locations = (Array.isArray(out.locations) ? out.locations : []).map((x) => clean(x, 100)).filter(Boolean).slice(0, 6);
    return json({
      fields: {
        supplier,
        otherSupplier: supplier === 'Other' ? clean(out.otherSupplier, 80) : '',
        locations,
        invoiceNo: clean(out.docketNo, 40),
        invoiceDate: cleanDate(out.deliveryDate),
      },
    });
  }
  return json({
    fields: {
      supplier: clean(out.supplier, 80),
      invoiceNo: clean(out.invoiceNo, 40),
      invoiceDate: cleanDate(out.invoiceDate),
      total: cleanTotal(out.total),
    },
  });
}

/* ------------------------------------------------------------------ office */

async function officeOverview(env) {
  const sites = await getSites(env);
  const months = recentMonths(RECENT_MONTHS);
  const result = await Promise.all(sites.map(async (s) => {
    const [inv, dk] = await Promise.all(['invoice', 'docket'].map((kind) => Promise.all(months.map((m) => listMonth(env, kind, s.id, m)))));
    const newInvoices = inv.flat().filter((r) => r.status === 'new');
    const newDockets = dk.flat().filter((r) => r.status === 'new');
    return {
      id: s.id, name: s.name, archived: !!s.archived, dockets: s.dockets || [],
      monthInvoices: inv[0].length,
      monthDockets: dk[0].length,
      newCount: newInvoices.length,
      newDockets: newDockets.length,
      newRecords: newInvoices.concat(newDockets),
    };
  }));
  return json({ month: months[0], months, sites: result });
}

async function officeMonths(env, kind, siteId) {
  await requireSite(env, siteId, { allowArchived: true });
  const months = await listSiteMonths(env, kind, siteId);
  const cur = bneNow().month;
  if (!months.includes(cur)) months.unshift(cur);
  return json({ months });
}

async function officeRecords(env, kind, siteId, month) {
  const site = await requireSite(env, siteId, { allowArchived: true });
  checkMonth(month);
  return json({ site: { id: site.id, name: site.name }, kind, month, records: await listMonth(env, kind, site.id, month) });
}

async function officePage(env, kind, siteId, month, id, n, download) {
  checkSiteId(siteId); checkMonth(month); checkInvId(id);
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) fail(400, 'Bad page.');
  const obj = await env.INVOICES.get(pageKey(kind, siteId, month, id, page));
  if (!obj) fail(404, 'Photo not found.');
  const headers = { 'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', 'cache-control': 'private, max-age=3600' };
  if (download) headers['content-disposition'] = `attachment; filename="${safeFilename(download).replace(/"/g, '')}"`;
  return new Response(obj.body, { headers });
}

async function officeUpdate(request, env) {
  const b = await readBody(request);
  const kind = kindOf(b.kind);
  checkSiteId(b.site); checkMonth(b.month); checkInvId(b.id);
  const rec = await getMeta(env, kind, b.site, b.month, b.id);
  if ('status' in b) {
    rec.status = b.status === 'processed' ? 'processed' : 'new';
    rec.processedAt = rec.status === 'processed' ? bneNow().local : '';
  }
  if ('supplier' in b) { const s = clean(b.supplier, 80); if (!s) fail(400, 'Supplier cannot be blank.'); rec.supplier = s; }
  if ('invoiceNo' in b) rec.invoiceNo = clean(b.invoiceNo, 40);
  if ('invoiceDate' in b) rec.invoiceDate = cleanDate(b.invoiceDate);
  if ('total' in b && kind === 'invoice') rec.total = cleanTotal(b.total);
  if ('note' in b) rec.note = clean(b.note, 300);
  await putMeta(env, rec);
  return json({ record: rec });
}

async function officeBulkStatus(request, env) {
  const b = await readBody(request, 256 * 1024);
  const items = Array.isArray(b.items) ? b.items : [];
  if (items.length > 400) fail(400, 'Too many at once. Do it in smaller batches.');
  const status = b.status === 'processed' ? 'processed' : 'new';
  const stamp = bneNow().local;
  let done = 0;
  for (let i = 0; i < items.length; i += 20) {
    await Promise.all(items.slice(i, i + 20).map(async (it) => {
      if (!SITE_RE.test(it.site || '') || !MONTH_RE.test(it.month || '') || !INV_RE.test(it.id || '')) return;
      const kind = kindOf(it.kind);
      const obj = await env.INVOICES.get(metaKey(kind, it.site, it.month, it.id));
      if (!obj) return;
      const rec = await obj.json();
      rec.kind = kind;
      rec.status = status;
      rec.processedAt = status === 'processed' ? stamp : '';
      await putMeta(env, rec);
      done++;
    }));
  }
  return json({ ok: true, updated: done });
}

async function officeDelete(request, env) {
  const b = await readBody(request);
  const kind = kindOf(b.kind);
  checkSiteId(b.site); checkMonth(b.month); checkInvId(b.id);
  const { objects } = await listAll(env, { prefix: recPrefix(kind, b.site, b.month, b.id) });
  if (!objects.length) fail(404, `That ${NOUN[kind]} was not found.`);
  await env.INVOICES.delete(objects.map((o) => o.key));
  return json({ ok: true, deleted: objects.length });
}

async function officeSites(request, env) {
  const b = await readBody(request);
  const sites = await getSites(env);
  const byName = (name) => sites.find((s) => s.name.toLowerCase() === name.toLowerCase());

  if (b.action === 'add') {
    const names = (Array.isArray(b.names) ? b.names : [b.name]).map((n) => clean(n, 60)).filter(Boolean);
    if (!names.length) fail(400, 'Enter at least one site name.');
    if (sites.length + names.length > 300) fail(400, 'That is more sites than this app allows.');
    const docket = clean(b.docket, 100);
    const added = [];
    let linkedTo = null;
    for (const name of names) {
      const existing = byName(name);
      if (existing) { if (docket && !linkedTo) linkedTo = existing; continue; }
      let id = slugify(name);
      for (let i = 2; sites.some((s) => s.id === id); i++) id = `${slugify(name).slice(0, 36)}-${i}`;
      const site = { id, name, dockets: [], archived: false };
      sites.push(site);
      added.push(site);
      if (docket && !linkedTo) linkedTo = site;
    }
    // Optionally link an old Fuel Dockets location to the (first) site named; it belongs to one site only.
    if (docket && linkedTo) {
      for (const s of sites) s.dockets = (s.dockets || []).filter((d) => d !== docket);
      linkedTo.dockets.push(docket);
    }
    sites.sort((a, b2) => a.name.localeCompare(b2.name));
    await saveSites(env, sites);
    return json({ sites, added: added.map((s) => s.id) });
  }

  if (b.action === 'update') {
    checkSiteId(b.id);
    const site = sites.find((s) => s.id === b.id);
    if (!site) fail(404, 'Site not found.');
    if ('name' in b) {
      const name = clean(b.name, 60);
      if (!name) fail(400, 'Site name cannot be blank.');
      const other = byName(name);
      if (other && other !== site) fail(400, 'Another site already has that name.');
      site.name = name;
    }
    if ('archived' in b) site.archived = !!b.archived;
    if (Array.isArray(b.dockets)) {
      const list = [...new Set(b.dockets.map((d) => clean(d, 100)).filter(Boolean))].slice(0, 20);
      site.dockets = list;
      // An old Fuel Dockets location belongs to one site only.
      for (const s of sites) if (s !== site) s.dockets = (s.dockets || []).filter((d) => !list.includes(d));
    }
    sites.sort((a, b2) => a.name.localeCompare(b2.name));
    await saveSites(env, sites);
    return json({ sites });
  }

  fail(400, 'Unknown action.');
}

/* ------------------------------------------- one-off import from Fuel Dockets */
// The old app files photos by location name → supplier → date (DD-MM-YYYY). Each of those becomes
// one docket here, under the site its location is linked to. Ids are derived from the location,
// supplier and date, so running the import again skips what is already here.

async function importId(loc, sup, date) {
  const [, dd, mm, yyyy] = OLD_DATE_RE.exec(date);
  return { id: `${yyyy}${mm}${dd}-000000-${(await sha256Hex(`${loc}|${sup}|${date}`)).slice(0, 4)}`, month: `${yyyy}-${mm}`, ymd: `${yyyy}-${mm}-${dd}` };
}

async function importPlan(env) {
  if (!docketsBound(env)) fail(501, 'The old Fuel Dockets address is not set (DOCKETS_URL).');
  const [data, sites] = await Promise.all([docketsJSON(env, '/browse'), getSites(env)]);
  const linked = {};
  for (const s of sites) for (const d of s.dockets || []) linked[d] = s;
  const locations = Array.isArray(data.locations) ? data.locations : [];
  const entries = [];
  const unlinked = [];
  for (const l of locations) {
    const site = linked[l.name];
    if (!site) { unlinked.push(l.name); continue; }
    for (const sp of l.suppliers || []) {
      for (const date of sp.dates || []) {
        if (!OLD_DATE_RE.test(date)) continue;
        entries.push({ loc: l.name, sup: sp.name, date, site: site.id, siteName: site.name });
      }
    }
  }
  if (entries.length > 900) entries.length = 900; // stays inside the per-request storage-call limit
  for (let i = 0; i < entries.length; i += 25) {
    await Promise.all(entries.slice(i, i + 25).map(async (e) => {
      const { id, month } = await importId(e.loc, e.sup, e.date);
      e.done = !!(await env.INVOICES.head(metaKey('docket', e.site, month, id)));
    }));
  }
  return json({ locations: locations.map((l) => l.name), unlinked, entries });
}

async function importOne(request, env) {
  if (!docketsBound(env)) fail(501, 'The old Fuel Dockets address is not set (DOCKETS_URL).');
  const b = await readBody(request);
  const loc = clean(b.loc, 120);
  const sup = clean(b.sup, 40);
  const date = clean(b.date, 20);
  if (!loc || !sup || !OLD_DATE_RE.test(date)) fail(400, 'Missing docket details.');
  const site = (await getSites(env)).find((s) => (s.dockets || []).includes(loc));
  if (!site) fail(400, `"${loc}" is not linked to a site yet.`);
  const { id, month, ymd } = await importId(loc, sup, date);
  if (await env.INVOICES.head(metaKey('docket', site.id, month, id))) return json({ skipped: true });

  const qs = `location=${encodeURIComponent(loc)}&supplier=${encodeURIComponent(sup)}&date=${encodeURIComponent(date)}`;
  const list = await docketsJSON(env, '/list?' + qs);
  const files = (Array.isArray(list.files) ? list.files : []).filter((f) => f && f.key).slice(0, MAX_PAGES);
  if (!files.length) return json({ empty: true });
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    let res;
    try { res = await docketsFetch(env, '/photo?key=' + encodeURIComponent(String(files[i].key))); } catch { fail(502, 'Could not reach the old Fuel Dockets app.'); }
    if (!res.ok) fail(502, `A photo for ${loc} on ${date} could not be fetched (${res.status}).`);
    const buf = await res.arrayBuffer();
    bytes += buf.byteLength;
    await env.INVOICES.put(pageKey('docket', site.id, month, id, i + 1), buf, { httpMetadata: { contentType: res.headers.get('content-type') || 'image/jpeg' } });
  }
  const rec = {
    kind: 'docket', site: site.id, month, id,
    supplier: OLD_SUPPLIERS[sup] || clean(sup, 80) || 'Other',
    invoiceNo: '', invoiceDate: ymd, total: '',
    note: 'Imported from Fuel Dockets (' + loc.replace(/_/g, ' ') + ')',
    by: 'Fuel Dockets', pages: files.length, bytes,
    uploadedAt: `${ymd}T00:00:00+10:00`,
    status: 'processed', processedAt: bneNow().local,
    also: '', source: 'fueldockets',
  };
  await putMeta(env, rec);
  return json({ record: rec });
}
