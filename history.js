'use strict';
// Records device readings into a local SQLite file and serves them for charts.
// Uses Node's built-in node:sqlite (Node 22.13+), so there is nothing native to compile.

const fs = require('fs');
const path = require('path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (_) {
  /* older Node: history is disabled */
}

// Which data points are worth charting
const RECORD_CODES = new Set([
  'cur_power', 'cur_voltage', 'cur_current', 'add_ele',
  'va_temperature', 'va_humidity', 'temp_value', 'battery_percentage',
]);
const HEARTBEAT_S = 300; // store an unchanged value at least this often
const MAX_HOLD_S = 600; // never assume a reading lasted longer than this (gaps = no data)
const TARGET_POINTS = 800;

function open(dir, keepDays) {
  if (!DatabaseSync) {
    console.warn('History is disabled: this Node version has no node:sqlite (needs Node 22.13 or newer).');
    return null;
  }
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'history.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS samples (
      ts    INTEGER NOT NULL,
      dev   TEXT    NOT NULL,
      code  TEXT    NOT NULL,
      value REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_samples ON samples (dev, code, ts);
  `);

  const insert = db.prepare('INSERT INTO samples (ts, dev, code, value) VALUES (?, ?, ?, ?)');
  const last = new Map(); // "dev|code" -> { v, ts }

  // Called after every successful poll. Only changed values (or a periodic heartbeat) are stored.
  function record(devices, ms) {
    const ts = Math.floor(ms / 1000);
    db.exec('BEGIN');
    try {
      for (const d of devices) {
        if (!d.online) continue;
        for (const dp of d.dps) {
          if (!RECORD_CODES.has(dp.code)) continue;
          if (typeof dp.display !== 'number' || !Number.isFinite(dp.display)) continue;
          const key = `${d.id}|${dp.code}`;
          const prev = last.get(key);
          if (prev && prev.v === dp.display && ts - prev.ts < HEARTBEAT_S) continue;
          insert.run(ts, d.id, dp.code, dp.display);
          last.set(key, { v: dp.display, ts });
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) {}
      console.warn('history write failed:', e.message);
    }
  }

  function prune() {
    const cutoff = Math.floor(Date.now() / 1000) - keepDays * 86400;
    try {
      db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff);
    } catch (e) {
      console.warn('history prune failed:', e.message);
    }
  }

  // Time series per data point, averaged into buckets so charts stay light.
  // Gaps (server was off, device offline) become null so lines break instead of bridging.
  function series(dev, hours) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - Math.round(hours * 3600);
    const bucket = Math.max(1, Math.ceil((now - from) / TARGET_POINTS));
    const gap = Math.max(MAX_HOLD_S, bucket * 3);
    const codes = db
      .prepare('SELECT DISTINCT code FROM samples WHERE dev = ? AND ts >= ? ORDER BY code')
      .all(dev, from)
      .map((r) => r.code);
    const q = db.prepare(
      `SELECT (ts / ?) * ? AS t, AVG(value) AS v
         FROM samples WHERE dev = ? AND code = ? AND ts >= ?
        GROUP BY t ORDER BY t`
    );
    return codes.map((code) => {
      const x = [];
      const y = [];
      for (const r of q.all(bucket, bucket, dev, code, from)) {
        if (x.length && r.t - x[x.length - 1] > gap) {
          x.push(x[x.length - 1] + 1);
          y.push(null);
        }
        x.push(r.t);
        y.push(Number(r.v.toFixed(3)));
      }
      return { code, x, y };
    });
  }

  // Daily energy in kWh, integrated from power readings (each reading is held until the next one).
  // Days before the first recorded reading are null rather than 0.
  function energy(dev, days) {
    const now = Math.floor(Date.now() / 1000);
    const startDay = new Date();
    startDay.setHours(0, 0, 0, 0);
    startDay.setDate(startDay.getDate() - (days - 1));
    const from = Math.floor(startDay.getTime() / 1000);

    const first = db
      .prepare("SELECT MIN(ts) AS m FROM samples WHERE dev = ? AND code = 'cur_power'")
      .get(dev).m;
    if (first == null) return null;
    const firstDay = new Date(first * 1000);
    firstDay.setHours(0, 0, 0, 0);
    const firstDayTs = Math.floor(firstDay.getTime() / 1000);

    const rows = db
      .prepare("SELECT ts, value FROM samples WHERE dev = ? AND code = 'cur_power' AND ts >= ? ORDER BY ts")
      .all(dev, from);
    const wh = new Map();
    for (let i = 0; i < rows.length; i++) {
      const nextTs = i + 1 < rows.length ? rows[i + 1].ts : now;
      const dur = Math.min(nextTs - rows[i].ts, MAX_HOLD_S);
      if (dur <= 0) continue;
      const day = new Date(rows[i].ts * 1000);
      day.setHours(0, 0, 0, 0);
      const key = Math.floor(day.getTime() / 1000);
      wh.set(key, (wh.get(key) || 0) + (rows[i].value * dur) / 3600);
    }

    const x = [];
    const y = [];
    const d = new Date(startDay);
    for (let i = 0; i < days; i++) {
      const t = Math.floor(d.getTime() / 1000);
      x.push(t);
      y.push(t < firstDayTs ? null : Number(((wh.get(t) || 0) / 1000).toFixed(3)));
      d.setDate(d.getDate() + 1);
    }
    return { x, y };
  }

  // GET /api/history?dev=<id>&hours=<n>
  function routes(app, getState) {
    app.get('/api/history', (req, res) => {
      const dev = getState().devices.find((d) => d.id === String(req.query.dev || ''));
      if (!dev) return res.status(404).json({ enabled: true, error: 'Unknown device' });
      const hours = Math.min(24 * 365, Math.max(1, Number(req.query.hours) || 24));
      const units = Object.fromEntries(dev.dps.map((dp) => [dp.code, dp.unit || '']));
      try {
        res.json({
          enabled: true,
          series: series(dev.id, hours).map((s) => ({ ...s, unit: units[s.code] || '' })),
          energy: energy(dev.id, Math.min(90, Math.max(7, Math.ceil(hours / 24)))),
        });
      } catch (e) {
        res.status(500).json({ enabled: true, error: e.message });
      }
    });
  }

  prune();
  setInterval(prune, 24 * 3600 * 1000).unref();
  return { record, series, energy, routes, prune, close: () => db.close() };
}

module.exports = { open };
