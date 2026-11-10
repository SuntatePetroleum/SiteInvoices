// Local test server: runs the Worker in Node with an in-memory stand-in for the R2 bucket and a
// pretend Fuel Dockets app (sample locations, photos and an invoice "reader").
//
//   node server.mjs [port]
//
// Optional: OFFICE_PIN=1234 STAFF_PIN=5678 node server.mjs   (to try the passcode screens)
import http from 'node:http';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register('./loader.mjs', import.meta.url);
const { default: worker } = await import('./index.js');

/* ---------------------------------------------------------- R2 stand-in */
function toBytes(v) {
  if (v == null) return new Uint8Array();
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v.slice(0));
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  throw new Error('Unsupported R2 value in dev server');
}
class R2Object {
  constructor(key, rec, withBody) {
    this.key = key; this.size = rec.body.length; this.uploaded = rec.uploaded;
    this.httpMetadata = rec.httpMetadata || {}; this.customMetadata = rec.customMetadata || {};
    if (withBody) {
      const bytes = rec.body;
      this.body = new Blob([bytes]).stream();
      this.arrayBuffer = async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.text = async () => new TextDecoder().decode(bytes);
      this.json = async () => JSON.parse(new TextDecoder().decode(bytes));
    }
  }
  writeHttpMetadata(headers) { if (this.httpMetadata.contentType) headers.set('content-type', this.httpMetadata.contentType); }
}
export class MemoryR2 {
  constructor() { this.map = new Map(); this.ops = { A: 0, B: 0 }; }
  async put(key, value, opts = {}) {
    this.ops.A++;
    const body = value && typeof value.arrayBuffer === 'function' && !(value instanceof ArrayBuffer) ? toBytes(await value.arrayBuffer()) : toBytes(value);
    this.map.set(key, { body, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata, uploaded: new Date() });
    return new R2Object(key, this.map.get(key), false);
  }
  async get(key) { this.ops.B++; const r = this.map.get(key); return r ? new R2Object(key, r, true) : null; }
  async head(key) { this.ops.B++; const r = this.map.get(key); return r ? new R2Object(key, r, false) : null; }
  async delete(keys) { this.ops.A++; for (const k of [].concat(keys)) this.map.delete(k); }
  async list({ prefix = '', delimiter, cursor, limit = 1000, include = [] } = {}) {
    this.ops.A++;
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const objects = []; const prefixes = new Set();
    for (const k of keys) {
      if (delimiter) {
        const rest = k.slice(prefix.length); const i = rest.indexOf(delimiter);
        if (i >= 0) { prefixes.add(prefix + rest.slice(0, i + 1)); continue; }
      }
      objects.push(k);
    }
    const start = cursor ? Number(cursor) : 0;
    const page = objects.slice(start, start + Math.min(limit, 7)); // small pages so paging gets exercised
    const truncated = start + page.length < objects.length;
    return {
      objects: page.map((k) => { const r = this.map.get(k); const o = new R2Object(k, r, false); if (!include.includes('customMetadata')) o.customMetadata = undefined; return o; }),
      delimitedPrefixes: start === 0 ? [...prefixes] : [],
      truncated, cursor: truncated ? String(start + page.length) : undefined,
    };
  }
}

/* ---------------------------------------------------- pretend Fuel Dockets */
const samplePhoto = await readFile(new URL('./sample-docket.jpg', import.meta.url)).catch(() => null);
const FAKE_LOCATIONS = [
  { name: 'Goomborian', suppliers: [{ name: 'Viva', dates: ['04-11-2026', '28-10-2026'] }, { name: 'IOR', dates: ['01-11-2026'] }] },
  { name: 'Liberty Ross Creek #10329', suppliers: [{ name: 'Viva', dates: ['05-11-2026'] }] },
  { name: 'Shell Gore', suppliers: [{ name: 'Viva', dates: ['03-11-2026'] }] },
];
export const fakeDockets = {
  analyseCalls: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/browse') return Response.json({ locations: FAKE_LOCATIONS });
    if (url.pathname === '/list') {
      const key = (n) => `${url.searchParams.get('location')}/${url.searchParams.get('supplier')}/${url.searchParams.get('date')}/docket_${n}.jpg`;
      return Response.json({ files: [{ name: 'docket_1.jpg', key: key(1) }, { name: 'docket_2.jpg', key: key(2) }] });
    }
    if (url.pathname === '/photo') {
      if (!samplePhoto) return new Response('no sample', { status: 404 });
      return new Response(samplePhoto, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.pathname === '/analyse' && request.method === 'POST') {
      this.analyseCalls++;
      const body = await request.json();
      const imgs = body.messages[0].content.filter((c) => c.type === 'image').length;
      const prompt = body.messages[0].content.filter((c) => c.type === 'text').map((c) => c.text).join(' ');
      const text = /fuel delivery docket/.test(prompt)
        ? JSON.stringify({ supplier: 'Viva', otherSupplier: null, locations: ['Goomboorian', 'Gympie'], docketNo: 'BOL-55120', deliveryDate: '2026-11-04', _pages: imgs })
        : JSON.stringify({ supplier: 'Coca-Cola Europacific Partners Pty Ltd', invoiceNo: 'INV-208341', invoiceDate: '2026-11-05', total: '1,284.60', _pages: imgs });
      return Response.json({ content: [{ type: 'text', text }] });
    }
    return new Response('Not found', { status: 404 });
  },
};

/* --------------------------------------------------------------- server */
export function makeEnv(extra = {}) {
  return {
    INVOICES: new MemoryR2(),
    DOCKETS: fakeDockets,
    DOCKETS_URL: 'https://fueldockets.example.workers.dev',
    AUTOFILL: 'on',
    OFFICE_PIN: process.env.OFFICE_PIN || undefined,
    STAFF_PIN: process.env.STAFF_PIN || undefined,
    ...extra,
  };
}

export function serve(port, env) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const waits = [];
    let response;
    try { response = await worker.fetch(request, env, { waitUntil: (p) => waits.push(p), passThroughOnException() {} }); }
    catch (e) { console.error(e); response = new Response('dev server error', { status: 500 }); }
    const out = {};
    response.headers.forEach((v, k) => { out[k] = v; });
    // Browsers drop "Secure" cookies on plain http (except localhost); keep them working anywhere in dev.
    if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].replace(/;\s*Secure/i, '');
    res.writeHead(response.status, out);
    if (response.body) for await (const c of response.body) res.write(c);
    res.end();
    await Promise.all(waits);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 8787);
  await serve(port, makeEnv());
  console.log(`Site Invoices running at http://localhost:${port}`);
}
