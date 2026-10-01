/*
=============================================================================
MODULE: backend/tests/loader.mjs
PURPOSE: Offline test harness. Registers ESM loader hooks that mock every
"wix-*" module and map "backend/<name>" specifiers to src/backend/<name>.js,
so the real backend code can be imported and exercised with `node --test`
without a Wix Velo runtime and without node_modules.
SCOPE: tests only. Never imported by production code. G10 ASCII strict.
=============================================================================
*/

import { pathToFileURL } from 'node:url';
import { fileURLToPath, pathToFileURL as p2u } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/backend/tests -> src/backend
export const BACKEND_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Mock registry (mutable so tests can seed data / inspect calls)
// ---------------------------------------------------------------------------

export const wixDataMock = {
  _store: new Map(),          // collectionName -> array of items
  _calls: [],                 // audit trail of operations
  _seed(collection, items) {
    this._store.set(collection, JSON.parse(JSON.stringify(items)));
  },
  _reset() {
    this._store.clear();
    this._calls.length = 0;
  },
  query(collection) {
    const rows = () => this._store.get(collection) || [];
    const state = { filters: [], limitN: 30 };
    const q = {
      eq(field, value) { state.filters.push([field, value]); return q; },
      in(field, values) { state.filters.push([field, values]); return q; },
      ne(field, value) { state.filters.push(['!=', field, value]); return q; },
      ascending() { return q; },
      descending() { return q; },
      limit(n) { state.limitN = n; return q; },
      find: async () => {
        this._calls.push({ op: 'query', collection });
        let items = rows().slice();
        for (const f of state.filters) {
          if (f[0] === '!=') { items = items.filter((it) => it[f[1]] !== f[2]); }
          else if (Array.isArray(f[1])) { items = items.filter((it) => f[1].includes(it[f[0]])); }
          else { items = items.filter((it) => it[f[0]] === f[1]); }
        }
        items = items.slice(0, state.limitN);
        return { items, total: items.length };
      },
    };
    return q;
  },
  get: async (collection, id) => {
    wixDataMock._calls.push({ op: 'get', collection });
    const rows = wixDataMock._store.get(collection) || [];
    return rows.find((r) => r._id === id) || null;
  },
  insert: async (collection, item) => {
    wixDataMock._calls.push({ op: 'insert', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const saved = { _id: 'mock_' + (rows.length + 1), ...item };
    rows.push(saved);
    wixDataMock._store.set(collection, rows);
    return saved;
  },
  update: async (collection, item) => {
    wixDataMock._calls.push({ op: 'update', collection });
    const rows = wixDataMock._store.get(collection) || [];
    const idx = rows.findIndex((r) => r._id === item._id);
    if (idx >= 0) rows[idx] = item; else rows.push(item);
    return item;
  },
  remove: async (collection, item) => {
    wixDataMock._calls.push({ op: 'remove', collection });
    return item;
  },
};

export const mocks = {
  wixData: wixDataMock,
  logger: {
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
    _calls: [],
  },
};

const GENERIC_STUB_SOURCE = `
const fnProxy = new Proxy(function () {}, {
  get: (t, p) => {
    if (p === 'then') return undefined;
    return fnProxy;
  },
  apply: () => fnProxy,
});
export const webMethod = (...args) => {
  // Real Velo semantics: webMethod(perm..., handler) returns the handler
  // (optionally wrapped). Tests call the exported handlers directly, so the
  // last function argument must be returned as-is.
  const fns = args.filter((a) => typeof a === 'function');
  return fns.length ? fns[fns.length - 1] : (handlerFn) => handlerFn;
};
export const Permissions = { Admin: 'ADMIN', SiteMember: 'MEMBER', Public: 'PUBLIC', Anyone: 'ANYONE' };
export const currentMember = fnProxy;
export const locations = fnProxy;
export const bookingsBackend = fnProxy;
export const paymentsBackend = fnProxy;
export const transactions = fnProxy;
export const media = fnProxy;
export const crypto = fnProxy;
// Named SDK exports imported by backend code (offline stubs):
export const availabilityTimeSlots = fnProxy;
export const bookings = fnProxy;
export const checkout = fnProxy;
export const orders = fnProxy;
export const elevate = fnProxy;
export const createClient = () => fnProxy;
export const getSecret = async () => "mock-secret";
export function _namedExportFallback(name) { return fnProxy; }
const handler = { get: (t, p) => {
  if (p === 'then') return undefined;
  if (p === 'webMethod') return webMethod;
  if (p === 'Permissions') return Permissions;
  if (p === 'default') return fnProxy;
  if (!(p in t)) { t[p] = fnProxy; }
  return t[p];
} };
const mod = new Proxy({ default: fnProxy }, handler);
export default mod.default;
`;

const WIX_DATA_SOURCE = `
import { wixDataMock } from ${JSON.stringify(p2u(path.join(BACKEND_DIR, 'tests/loader.mjs')).href.replace(/\\/g, '/'))};
export default wixDataMock;
`;

// ---------------------------------------------------------------------------
// resolve/load hooks (used when run WITH --experimental-loader)
// ---------------------------------------------------------------------------

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('wix-') || specifier.startsWith('@wix/')) {
    // Offline harness: every Wix SDK package resolves to the generic stub.
    // wix-data keeps its dedicated in-memory mock below.
    return { url: 'mock:' + specifier, shortCircuit: true };
  }
  if (specifier.startsWith('backend/') || specifier.startsWith('public/')) {
    const rel = specifier.includes('/') ? specifier.slice(specifier.indexOf('/') + 1) : specifier;
    const rootDir = specifier.startsWith('public/') ? path.join(BACKEND_DIR, '..', 'public') : BACKEND_DIR;
    const abs = path.join(rootDir, rel.endsWith('.js') ? rel : rel + '.js');
    if (!fs.existsSync(abs)) {
      throw new Error('loader.mjs: cannot resolve Velo alias specifier ' + specifier + ' -> ' + abs);
    }
    return { url: pathToFileURL(abs).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('mock:wix-data')) {
    return { format: 'module', source: WIX_DATA_SOURCE, shortCircuit: true };
  }
  if (url.startsWith('mock:')) {
    return { format: 'module', source: GENERIC_STUB_SOURCE, shortCircuit: true };
  }
  return nextLoad(url, context);
}
