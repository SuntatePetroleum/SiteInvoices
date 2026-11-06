// Sunstate Petroleum — Site Invoices.
// One Cloudflare Worker: serves the app and a small JSON API.
// Invoice photos and their details are kept in an R2 bucket (binding INVOICES):
//
//   config/sites.json                                  site list (+ linked Fuel Dockets locations)
//   config/suppliers.json                              supplier names seen so far (for suggestions)
//   invoices/<site>/<YYYY-MM>/<invoice id>/p1.jpg ...  one JPEG per page
//   invoices/<site>/<YYYY-MM>/<invoice id>/meta.json   invoice details; also copied into the
//                                                      object's custom metadata so a month can be
//                                                      listed in one call
//
// The Fuel Dockets app is reached through a service binding (DOCKETS). It is used to show each
// site's dockets in the office view and to read invoice photos with Fuel Dockets' /analyse proxy.

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
const ROOT = 'invoices/';

const SITE_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const INV_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_PAGES = 30;
const MAX_PAGE_BYTES = 15 * 1024 * 1024;
const MAX_AUTOFILL_BYTES = 12 * 1024 * 1024;
const RECENT_MONTHS = 3; // office "new invoices" looks back this many months

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
function checkInvId(v) { if (!INV_RE.test(String(v || ''))) fail(400, 'Bad invoice id.'); return v; }

const invPrefix = (site, month, id) => `${ROOT}${site}/${month}/${id}/`;
const metaKey = (site, month, id) => invPrefix(site, month, id) + 'meta.json';
const pageKey = (site, month, id, n) => invPrefix(site, month, id) + `p${n}.jpg`;

function safeFilename(s) {
  return String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';
}

/* -------------------------------------------------------------------- auth */
// Optional passcodes, set as Worker secrets: OFFICE_PIN (office screens) and STAFF_PIN (site
// uploads). When one is set, a correct entry leaves a signed cookie on that device. Changing the
// secret signs every device out. An office cookie also allows staff actions.

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

async function requireSite(env, siteId, { allowArchived = false } = {}) {
  checkSiteId(siteId);
  const site = (await getSites(env)).find((s) => s.id === siteId);
  if (!site || (site.archived && !allowArchived)) fail(404, 'That site is not set up. Ask the office.');
  return site;
}

const META_FIELDS = ['supplier', 'invoiceNo', 'invoiceDate', 'total', 'note', 'by', 'pages', 'bytes', 'uploadedAt', 'status', 'processedAt'];

function recordFromListed(obj) {
  const [, site, month, id] = obj.key.split('/');
  const m = obj.customMetadata || {};
  return {
    site, month, id,
    supplier: m.supplier || '', invoiceNo: m.invoiceNo || '', invoiceDate: m.invoiceDate || '',
    total: m.total || '', note: m.note || '', by: m.by || '',
    pages: Number(m.pages) || 0, bytes: Number(m.bytes) || 0,
    uploadedAt: m.uploadedAt || '', status: m.status === 'processed' ? 'processed' : 'new',
    processedAt: m.processedAt || '',
  };
}

async function putMeta(env, rec) {
  const customMetadata = {};
  for (const f of META_FIELDS) customMetadata[f] = String(rec[f] ?? '');
  await env.INVOICES.put(metaKey(rec.site, rec.month, rec.id), JSON.stringify(rec), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata,
  });
}

async function getMeta(env, site, month, id) {
  const obj = await env.INVOICES.get(metaKey(site, month, id));
  if (!obj) fail(404, 'That invoice was not found. It may have been deleted.');
  return obj.json();
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

async function listMonth(env, site, month) {
  const { objects } = await listAll(env, { prefix: `${ROOT}${site}/${month}/`, include: ['customMetadata'] });
  return objects.filter((o) => o.key.endsWith('/meta.json')).map(recordFromListed).sort((a, b) => b.id.localeCompare(a.id));
}

async function listSiteMonths(env, site) {
  const { prefixes } = await listAll(env, { prefix: `${ROOT}${site}/`, delimiter: '/' });
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

/* ------------------------------------------------------------ fuel dockets */

function docketsBound(env) { return !!(env.DOCKETS && typeof env.DOCKETS.fetch === 'function') || !!env.DOCKETS_URL; }

async function docketsFetch(env, path, init) {
     if (env.DOCKETS && typeof env.DOCKETS.fetch === 'function') return env.DOCKETS.fetch(new Request('https://fueldockets' + path, init));
  const base = String(env.DOCKETS_URL || DEFAULT_DOCKETS_URL).replace(/\/+$/, '');
  return fetch(base + path, init);
}

async function docketsJSON(env, path) {
  let res;
  try { res = await docketsFetch(env, path); } catch { fail(502, 'Could not reach Fuel Dockets.'); }
  if (!res.ok) fail(502, 'Fuel Dockets did not answer (' + res.status + ').');
  try { return await res.json(); } catch { fail(502, 'Fuel Dockets sent something unexpected.'); }
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

  // ---- open to everyone
  if (path === '/api/config' && method === 'GET') return getConfig(request, env);
  if (path === '/api/auth' && method === 'POST') return handleAuth(request, env);
  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': 'ssp_office=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }

  // ---- site staff
  if (parts[0] === 'staff') {
    await requireRole(request, env, 'staff');
    const action = parts[1];
    if (action === 'suppliers' && method === 'GET') return staffSuppliers(env);
    if (action === 'recent' && method === 'GET') return staffRecent(env, q.get('site'));
    if (action === 'start' && method === 'POST') return staffStart(request, env);
    if (action === 'page' && method === 'PUT' && parts.length === 6) return staffPage(request, env, parts[2], parts[3], parts[4], parts[5]);
    if (action === 'finish' && method === 'POST') return staffFinish(request, env, ctx);
    if (action === 'autofill' && method === 'POST') return staffAutofill(request, env);
    fail(404, 'Not found.');
  }

  // ---- office
  if (parts[0] === 'office') {
    await requireRole(request, env, 'office');
    const action = parts[1];
    if (action === 'overview' && method === 'GET') return officeOverview(env);
    if (action === 'months' && method === 'GET') return officeMonths(env, q.get('site'));
    if (action === 'invoices' && method === 'GET') return officeInvoices(env, q.get('site'), q.get('month'));
    if (action === 'page' && method === 'GET' && parts.length === 6) return officePage(env, parts[2], parts[3], parts[4], parts[5], q.get('download'));
    if (action === 'update' && method === 'POST') return officeUpdate(request, env);
    if (action === 'status' && method === 'POST') return officeBulkStatus(request, env);
    if (action === 'delete' && method === 'POST') return officeDelete(request, env);
    if (action === 'sites' && method === 'POST') return officeSites(request, env);
    if (action === 'dockets') {
      if (parts[2] === 'locations' && method === 'GET') return docketsLocations(env);
      if (parts[2] === 'list' && method === 'GET') return docketsList(env, q);
      if (parts[2] === 'photo' && method === 'GET') return docketsPhoto(env, q.get('key'), q.get('download'));
    }
    fail(404, 'Not found.');
  }

  fail(404, 'Not found.');
}

/* ------------------------------------------------------------------ config */

async function getConfig(request, env) {
  const sites = await getSites(env);
  const [staffOk, officeOk] = await Promise.all([hasRole(request, env, 'staff'), hasRole(request, env, 'office')]);
  return json({
    sites: sites.map((s) => ({ id: s.id, name: s.name, archived: !!s.archived })),
    staffPin: !!env.STAFF_PIN,
    officePin: !!env.OFFICE_PIN,
    staffOk,
    officeOk,
    docketsUrl: String(env.DOCKETS_URL || DEFAULT_DOCKETS_URL),
    docketsLinked: docketsBound(env),
    autofill: docketsBound(env) && String(env.AUTOFILL || '').toLowerCase() !== 'off',
    autofillModel: String(env.AUTOFILL_MODEL || 'claude-sonnet-4-6'),
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
  let recs = await listMonth(env, siteId, cur);
  if (recs.length < 6) recs = recs.concat(await listMonth(env, siteId, prev));
  const items = recs.slice(0, 6).map((r) => ({
    id: r.id, supplier: r.supplier, invoiceNo: r.invoiceNo, pages: r.pages, by: r.by, uploadedAt: r.uploadedAt, status: r.status,
  }));
  return json({ items });
}

async function staffStart(request, env) {
  const b = await readBody(request);
  const site = await requireSite(env, b.site);
  const now = bneNow();
  const id = `${now.stamp}-${rand(4)}`;

  // Has this invoice number already come through for this site recently?
  let duplicate = null;
  const invNo = normKey(b.invoiceNo);
  if (invNo.length >= 3) {
    const supplier = normKey(b.supplier);
    const months = recentMonths(2);
    for (const m of months) {
      const recs = await listMonth(env, site.id, m);
      const hit = recs.find((r) => normKey(r.invoiceNo) === invNo && (!supplier || !normKey(r.supplier) || normKey(r.supplier) === supplier));
      if (hit) { duplicate = { supplier: hit.supplier, invoiceNo: hit.invoiceNo, by: hit.by, uploadedAt: hit.uploadedAt }; break; }
    }
  }
  return json({ id, month: now.month, duplicate });
}

async function staffPage(request, env, siteId, month, id, n) {
  checkSiteId(siteId); checkMonth(month); checkInvId(id);
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) fail(400, 'Too many pages for one invoice.');
  if (!/^image\/jpeg\b/i.test(request.headers.get('content-type') || '')) fail(415, 'Photos must be sent as JPEG.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_PAGE_BYTES) fail(413, 'That photo is too large.');
  await requireSite(env, siteId);
  if (await env.INVOICES.head(metaKey(siteId, month, id))) fail(409, 'This invoice has already been sent.');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) fail(400, 'The photo was empty. Please try again.');
  if (buf.byteLength > MAX_PAGE_BYTES) fail(413, 'That photo is too large.');
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0xff || head[1] !== 0xd8) fail(415, 'That file is not a JPEG photo.');
  await env.INVOICES.put(pageKey(siteId, month, id, page), buf, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ ok: true, page, bytes: buf.byteLength });
}

async function staffFinish(request, env, ctx) {
  const b = await readBody(request);
  const site = await requireSite(env, b.site);
  const month = checkMonth(b.month);
  const id = checkInvId(b.id);
  const pages = Number(b.pages);
  if (!Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES) fail(400, 'Add at least one photo.');

  const existing = await env.INVOICES.get(metaKey(site.id, month, id));
  if (existing) return json({ record: await existing.json(), already: true });

  const supplier = clean(b.supplier, 80);
  const by = clean(b.by, 40);
  if (!supplier) fail(400, 'Enter the supplier.');
  if (!by) fail(400, 'Enter your name.');

  // Every page must be there, and any pages left over from an earlier attempt are removed.
  const { objects } = await listAll(env, { prefix: invPrefix(site.id, month, id) });
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
  const extra = Object.keys(sizes).map(Number).filter((i) => i > pages).map((i) => pageKey(site.id, month, id, i));
  if (extra.length) await env.INVOICES.delete(extra);

  const rec = {
    site: site.id, month, id,
    supplier,
    invoiceNo: clean(b.invoiceNo, 40),
    invoiceDate: cleanDate(b.invoiceDate),
    total: cleanTotal(b.total),
    note: clean(b.note, 300),
    by,
    pages, bytes,
    uploadedAt: bneNow().local,
    status: 'new',
    processedAt: '',
  };
  await putMeta(env, rec);
  const remember = rememberSupplier(env, supplier).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(remember); else await remember;
  return json({ record: rec });
}

// Reads invoice photos with Claude through Fuel Dockets' existing /analyse proxy, so this app
// needs no API key of its own. The page builds the request; it is passed through unchanged.
async function staffAutofill(request, env) {
  if (!docketsBound(env)) fail(501, 'Auto-fill needs the Fuel Dockets connection.');
  if (String(env.AUTOFILL || '').toLowerCase() === 'off') fail(501, 'Auto-fill is turned off.');
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_AUTOFILL_BYTES) fail(413, 'Photos are too large to read.');
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_AUTOFILL_BYTES) fail(413, 'Photos are too large to read.');
  let res;
  try {
    res = await docketsFetch(env, '/analyse', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  } catch {
    fail(502, 'Could not reach the reader.');
  }
  return new Response(res.body, {
    status: res.ok ? 200 : 502,
    headers: { 'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' },
  });
}

/* ------------------------------------------------------------------ office */

async function officeOverview(env) {
  const sites = await getSites(env);
  const months = recentMonths(RECENT_MONTHS);
  const result = await Promise.all(sites.map(async (s) => {
    const lists = await Promise.all(months.map((m) => listMonth(env, s.id, m)));
    const newRecords = lists.flat().filter((r) => r.status === 'new');
    return {
      id: s.id, name: s.name, archived: !!s.archived, dockets: s.dockets || [],
      monthTotal: lists[0].length,
      newCount: newRecords.length,
      newRecords,
    };
  }));
  return json({ month: months[0], months, sites: result });
}

async function officeMonths(env, siteId) {
  await requireSite(env, siteId, { allowArchived: true });
  const months = await listSiteMonths(env, siteId);
  const cur = bneNow().month;
  if (!months.includes(cur)) months.unshift(cur);
  return json({ months });
}

async function officeInvoices(env, siteId, month) {
  const site = await requireSite(env, siteId, { allowArchived: true });
  checkMonth(month);
  return json({ site: { id: site.id, name: site.name }, month, invoices: await listMonth(env, site.id, month) });
}

async function officePage(env, siteId, month, id, n, download) {
  checkSiteId(siteId); checkMonth(month); checkInvId(id);
  const page = Number(n);
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) fail(400, 'Bad page.');
  const obj = await env.INVOICES.get(pageKey(siteId, month, id, page));
  if (!obj) fail(404, 'Photo not found.');
  const headers = { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' };
  if (download) headers['content-disposition'] = `attachment; filename="${safeFilename(download).replace(/"/g, '')}"`;
  return new Response(obj.body, { headers });
}

async function officeUpdate(request, env) {
  const b = await readBody(request);
  checkSiteId(b.site); checkMonth(b.month); checkInvId(b.id);
  const rec = await getMeta(env, b.site, b.month, b.id);
  if ('status' in b) {
    rec.status = b.status === 'processed' ? 'processed' : 'new';
    rec.processedAt = rec.status === 'processed' ? bneNow().local : '';
  }
  if ('supplier' in b) { const s = clean(b.supplier, 80); if (!s) fail(400, 'Supplier cannot be blank.'); rec.supplier = s; }
  if ('invoiceNo' in b) rec.invoiceNo = clean(b.invoiceNo, 40);
  if ('invoiceDate' in b) rec.invoiceDate = cleanDate(b.invoiceDate);
  if ('total' in b) rec.total = cleanTotal(b.total);
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
      const obj = await env.INVOICES.get(metaKey(it.site, it.month, it.id));
      if (!obj) return;
      const rec = await obj.json();
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
  checkSiteId(b.site); checkMonth(b.month); checkInvId(b.id);
  const { objects } = await listAll(env, { prefix: invPrefix(b.site, b.month, b.id) });
  if (!objects.length) fail(404, 'That invoice was not found.');
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
    // Optionally link a Fuel Dockets location to the (first) site named; it belongs to one site only.
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
      // A Fuel Dockets location belongs to one site only.
      for (const s of sites) if (s !== site) s.dockets = (s.dockets || []).filter((d) => !list.includes(d));
    }
    sites.sort((a, b2) => a.name.localeCompare(b2.name));
    await saveSites(env, sites);
    return json({ sites });
  }

  fail(400, 'Unknown action.');
}

/* ------------------------------------------------------ fuel dockets (office) */

async function docketsLocations(env) {
  const data = await docketsJSON(env, '/browse');
  return json({ locations: Array.isArray(data.locations) ? data.locations : [] });
}

async function docketsList(env, q) {
  const loc = clean(q.get('location'), 120);
  const sup = clean(q.get('supplier'), 40);
  const date = clean(q.get('date'), 20);
  if (!loc || !sup || !date) fail(400, 'Missing docket details.');
  const qs = `location=${encodeURIComponent(loc)}&supplier=${encodeURIComponent(sup)}&date=${encodeURIComponent(date)}`;
  const data = await docketsJSON(env, '/list?' + qs);
  return json({ files: Array.isArray(data.files) ? data.files.map((f) => ({ name: String(f.name || ''), key: String(f.key || '') })) : [] });
}

async function docketsPhoto(env, key, download) {
  if (!key || key.length > 400) fail(400, 'Bad photo key.');
  let res;
  try { res = await docketsFetch(env, '/photo?key=' + encodeURIComponent(key)); } catch { fail(502, 'Could not reach Fuel Dockets.'); }
  if (!res.ok) fail(res.status === 404 ? 404 : 502, 'Docket photo not available.');
  const headers = { 'content-type': res.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=3600' };
  if (download) headers['content-disposition'] = `attachment; filename="${safeFilename(download).replace(/"/g, '')}"`;
  return new Response(res.body, { headers });
}
