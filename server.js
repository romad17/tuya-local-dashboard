'use strict';
require('dotenv').config();

const path = require('path');
const express = require('express');
const { TuyaContext } = require('@tuya/tuya-connector-nodejs');

const { TUYA_ACCESS_ID, TUYA_ACCESS_SECRET } = process.env;
const BASE_URL = process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com';
const PORT = Number(process.env.PORT || 3000);
const POLL_SECONDS = Math.max(10, Number(process.env.POLL_SECONDS || 30));
const DEVICE_IDS = (process.env.DEVICE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TUYA_ACCESS_ID || !TUYA_ACCESS_SECRET) {
  console.error('Missing TUYA_ACCESS_ID / TUYA_ACCESS_SECRET. Copy .env.example to .env and fill them in.');
  process.exit(1);
}

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

app.get('/api/devices', (_req, res) => res.json(state));

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
