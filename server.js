'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const { TUYA_ACCESS_ID, TUYA_ACCESS_SECRET } = process.env;
const BASE_URL = process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com';
const PORT = Number(process.env.PORT || 3000);
const POLL_SECONDS = Math.max(10, Number(process.env.POLL_SECONDS || 30));
const HISTORY_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS || 365));
const DEVICE_IDS = (process.env.DEVICE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TUYA_ACCESS_ID || !TUYA_ACCESS_SECRET) {
  console.error('Missing TUYA_ACCESS_ID / TUYA_ACCESS_SECRET. Set them as environment variables, or copy .env.example to .env and fill them in.');
  process.exit(1);
}

// Local history database (data/history.db); null if this Node has no node:sqlite
const history = require('./history').open(path.join(__dirname, 'data'), HISTORY_DAYS);

const tuya = new TuyaContext({
  baseUrl: BASE_URL,
  accessKey: TUYA_ACCESS_ID,
  secretKey: TUYA_ACCESS_SECRET,
});

// ---------------------------------------------------------------- Tuya helpers

async function api(method, apiPath, opts = {}) {
  const res = await tuya.request({ method, path: apiPath, ...opts });
  if (!res || !res.success) {
    const err = new Error(`Tuya error ${res && res.code}: ${res && res.msg}`);
    err.code = res && res.code;
    throw err;
  }
  return res.result;
}

// All devices linked to the project via the Smart Life app account,
// or just the ones listed in DEVICE_IDS.
async function fetchAllDevices() {
  if (DEVICE_IDS.length) {
    const out = [];
    for (const id of DEVICE_IDS) out.push(await api('GET', `/v1.0/devices/${id}`));
    return out;
  }
  const all = [];
  let lastRowKey = '';
  do {
    const r = await api('GET', '/v1.0/iot-01/associated-users/devices', {
      query: { size: 100, last_row_key: lastRowKey },
    });
    all.push(...(r.devices || []));
    lastRowKey = r.has_more ? r.last_row_key : '';
  } while (lastRowKey);
  return all;
}

// Per-device data point definitions (type, scale, unit, which codes are writable)
const specCache = new Map();

function parseSpecEntry(x) {
  let values = {};
  try {
    values = JSON.parse(x.values || '{}');
  } catch (_) {}
  return { type: x.type, values };
}

async function getSpec(id) {
  if (specCache.has(id)) return specCache.get(id);
  const spec = { functions: {}, status: {} };
  try {
    const r = await api('GET', `/v1.0/devices/${id}/specifications`);
    for (const f of r.functions || []) spec.functions[f.code] = parseSpecEntry(f);
    for (const s of r.status || []) spec.status[s.code] = parseSpecEntry(s);
    specCache.set(id, spec); // only cache on success
  } catch (e) {
    console.warn(`specifications failed for ${id}: ${e.message}`);
  }
  return spec;
}

function present(dev, spec) {
  const dps = (dev.status || []).map(({ code, value }) => {
    const s = spec.functions[code] || spec.status[code] || {};
    const v = s.values || {};
    let display = value;
    if (s.type === 'Integer' && typeof value === 'number' && v.scale) {
      display = Number((value / Math.pow(10, v.scale)).toFixed(v.scale));
    }
    return {
      code,
      value,
      display,
      type: s.type || typeof value,
      unit: v.unit || '',
      scale: v.scale || 0,
      min: v.min,
      max: v.max,
      step: v.step,
      range: s.type === 'Enum' ? v.range : undefined,
      writable: Boolean(spec.functions[code]),
    };
  });
  return {
    id: dev.id,
    name: dev.name,
    online: Boolean(dev.online),
    updateTime: dev.update_time || null,
    product: dev.product_name || dev.category || '',
    dps,
  };
}

// ---------------------------------------------------------------- State + SSE

let state = { updatedAt: null, error: null, devices: [] };
const rawById = new Map(); // id -> raw device object from Tuya
const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

let polling = false;
async function refreshAll() {
  if (polling) return;
  polling = true;
  try {
    const devices = await fetchAllDevices();
    const out = [];
    for (const d of devices) {
      rawById.set(d.id, d);
      out.push(present(d, await getSpec(d.id)));
    }
    state = { updatedAt: Date.now(), error: null, devices: out };
    if (history) history.record(out, state.updatedAt);
  } catch (e) {
    console.error('refresh failed:', e.message);
    state = { ...state, error: e.message };
  } finally {
    polling = false;
    broadcast();
  }
}

// After a command, refresh just that device's status
async function refreshOne(id) {
  try {
    const status = await api('GET', `/v1.0/devices/${id}/status`);
    const raw = { ...(rawById.get(id) || { id }), status };
    rawById.set(id, raw);
    const view = present(raw, await getSpec(id));
    state = {
      ...state,
      updatedAt: Date.now(),
      devices: state.devices.map((d) => (d.id === id ? view : d)),
    };
    broadcast();
  } catch (e) {
    console.warn(`refreshOne(${id}) failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- HTTP server

const app = express();
app.use(express.json());

// Basic protection: only accept state-changing requests from our own page
app.use((req, res, next) => {
  if (req.method === 'POST') {
    const origin = req.get('origin');
    const ok = !origin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (!ok) return res.status(403).json({ ok: false, error: 'Forbidden origin' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/uplot', express.static(path.join(__dirname, 'node_modules', 'uplot', 'dist')));

app.get('/api/devices', (_req, res) => res.json(state));

if (history) history.routes(app, () => state);
else app.get('/api/history', (_req, res) => res.json({ enabled: false }));

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(state)}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/devices/:id/commands', async (req, res) => {
  const { id } = req.params;
  const { code, value } = req.body || {};
  if (typeof code !== 'string' || value === undefined) {
    return res.status(400).json({ ok: false, error: 'Body must be { code, value }' });
  }
  if (!state.devices.some((d) => d.id === id)) {
    return res.status(404).json({ ok: false, error: 'Unknown device' });
  }
  try {
    await api('POST', `/v1.0/devices/${id}/commands`, {
      body: { commands: [{ code, value }] },
    });
    setTimeout(() => refreshOne(id), 1000);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ---- Tuya cloud statistics: the numbers behind the Smart Life app's "Electricity Statistics"
// GET /api/cloud-stats?dev=<id>&days=<n>  ->  daily kWh from Tuya's own meter data (add_ele)
const STATS_TTL_MS = 10 * 60 * 1000;
const statsCache = new Map();
const STATS_HINTS = {
  28841101: 'The Statistics service is not enabled for this project. Others report it has to be requested through Tuya support.',
  2007: 'Statistics are not enabled for this data point on this product (a Tuya-side product setting).',
  28841002: 'An API subscription is missing. Check the Service API tab of your project.',
  1106: 'Permission denied. Check the Service API subscriptions and that the device is linked to the project.',
  1004: 'Request signature rejected. Check the Access ID and Secret.',
};
const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

app.get('/api/cloud-stats', async (req, res) => {
  const id = String(req.query.dev || '');
  const dev = state.devices.find((d) => d.id === id);
  if (!dev) return res.status(404).json({ available: false, error: 'Unknown device' });
  const code = 'add_ele';
  if (!dev.dps.some((d) => d.code === code)) {
    return res.json({ available: false, reason: 'This device has no energy counter (add_ele).' });
  }
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const today = new Date();
  const cacheKey = `${id}|${days}|${ymd(today)}`;
  const hit = statsCache.get(cacheKey);
  if (hit && Date.now() - hit.at < STATS_TTL_MS) return res.json(hit.value);

  try {
    // Ask Tuya how this data point is aggregated; energy counters are usually "sum" or "minux".
    let statType = 'sum';
    try {
      const types = await api('GET', `/v1.0/devices/${id}/all-statistic-type`, { query: { code } });
      const t = (Array.isArray(types) ? types : []).find((x) => x.code === code);
      const first = t && String(t.stat_type || '').split(/[\s,|]+/).filter(Boolean)[0];
      if (first) statType = first;
    } catch (e) {
      console.warn(`all-statistic-type failed for ${id}: ${e.message} (using "sum")`);
    }

    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const result = await api('GET', `/v1.0/devices/${id}/statistics/days`, {
      query: { code, start_day: ymd(start), end_day: ymd(today), stat_type: statType },
    });
    const map = (result && result.days) || {};

    const x = [];
    const y = [];
    let total = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const n = Number(map[ymd(d)]);
      x.push(Math.floor(d.getTime() / 1000));
      y.push(Number.isFinite(n) ? n : null);
      if (Number.isFinite(n)) total += n;
    }
    const value = {
      available: true, code, statType,
      x, y, total: Number(total.toFixed(3)),
      rawSample: Object.entries(map).slice(-3), // lets you compare Tuya's raw values with the app
    };
    statsCache.set(cacheKey, { at: Date.now(), value });
    res.json(value);
  } catch (e) {
    res.json({ available: false, error: e.message, code: e.code, hint: STATS_HINTS[e.code] || null });
  }
});

app.post('/api/refresh', async (_req, res) => {
  await refreshAll();
  res.json({ ok: true });
});

// Bind to localhost only: nothing else on your network can reach it
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Tuya dashboard running at http://localhost:${PORT}`);
  console.log(`Polling every ${POLL_SECONDS}s via ${BASE_URL}`);
  refreshAll();
  setInterval(refreshAll, POLL_SECONDS * 1000);
});
