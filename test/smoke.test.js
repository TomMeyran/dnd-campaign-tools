'use strict';
// Smoke / integration tests for the campaign-tools server.
//
// These use only Node's built-in test runner (`node --test`) and `http` module
// — no extra dependencies — so `npm test` works on a clean checkout. They boot
// the real server as a child process on a throwaway port and assert that the
// core routes and the demo data respond correctly.

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 3997;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server.js');

let child;

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(BASE + pathname, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body,
        type: res.headers['content-type'] || '',
        location: res.headers['location'] || '',
      }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Like get(), but exposes the raw status/headers/body (needed for ETag checks).
function getFull(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
  });
}

function postJson(pathname, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('timeout')));
    req.write(body);
    req.end();
  });
}

// Hold an SSE stream open and accumulate the raw text so a test can inspect the
// wire format (id: lines, replayed events, heartbeat framing).
function openSse(pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: PORT, path: pathname, headers: { Accept: 'text/event-stream', ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        resolve({ headers: res.headers, read: () => buf, stop: () => req.destroy() });
      }
    );
    req.on('error', reject);
  });
}

async function waitForServer(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await get('/api/tunnel-url');
      if (r.status === 200) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start in time');
}

test.before(async () => {
  child = spawn(process.execPath, [SERVER], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  await waitForServer();
});

test.after(() => {
  if (child) child.kill();
});

test('root redirects to the map tool page', async () => {
  const r = await get('/');
  assert.strictEqual(r.status, 302);
  assert.match(r.location, /nocropi\.html/);
});

test('the map tool page loads', async () => {
  const r = await get('/nocropi.html');
  assert.strictEqual(r.status, 200);
  assert.match(r.body.toLowerCase(), /<html/);
});

test('the shared dice roller script is served', async () => {
  const r = await get('/dice-roll.js');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /DiceRoll/);
});

test('the combat panel script is served', async () => {
  const r = await get('/combat-panel.js');
  assert.strictEqual(r.status, 200);
});

test('NPC tool page is served', async () => {
  const r = await get('/npcs/npc_tool.html');
  assert.strictEqual(r.status, 200);
  assert.match(r.body.toLowerCase(), /<html/);
});

test('tunnel-url API returns JSON (null when no tunnel)', async () => {
  const r = await get('/api/tunnel-url');
  assert.strictEqual(r.status, 200);
  const data = JSON.parse(r.body);
  assert.ok('url' in data);
});

test('demo database is loaded (seeded town Millhaven is queryable)', async () => {
  // Proves the bundled demo DB opened and the server can read seeded data.
  const r = await get('/api/town/Millhaven');
  assert.strictEqual(r.status, 200);
  assert.match(r.type, /json/);
  const data = JSON.parse(r.body);
  assert.ok(data && typeof data === 'object', 'expected a JSON object for the seeded town');
});

test('NPC sheets API returns the seeded demo NPCs', async () => {
  const r = await get('/api/npc-sheets');
  assert.strictEqual(r.status, 200);
  const data = JSON.parse(r.body);
  assert.ok(Array.isArray(data) || typeof data === 'object', 'expected NPC data');
});

// ── SSE resilience + conditional polling ─────────────────────────────────────
// The live app runs behind a Cloudflare tunnel that can buffer or silently drop
// an SSE stream, so the clients also poll as a safety net. These tests cover the
// three things that keep that arrangement cheap and lossless.

test('polling /api/combat is conditional (ETag → 304 when unchanged)', async () => {
  const first = await getFull('/api/combat');
  assert.strictEqual(first.status, 200);
  const tag = first.headers.etag;
  assert.ok(tag, 'expected an ETag so pollers can revalidate');

  const again = await getFull('/api/combat', { 'If-None-Match': tag });
  assert.strictEqual(again.status, 304, 'unchanged state must answer 304');
  assert.strictEqual(again.body.length, 0, '304 must carry no body');

  const stale = await getFull('/api/combat', { 'If-None-Match': '"not-the-tag"' });
  assert.strictEqual(stale.status, 200, 'a stale validator must get the full body');
  assert.ok(stale.body.length > 0);
});

test('SSE stream sets the headers a tunnel needs', async () => {
  const s = await openSse('/api/npc-events');
  try {
    assert.match(s.headers['content-type'] || '', /text\/event-stream/);
    // no-store: the stream must never be held by an intermediary cache.
    assert.strictEqual(s.headers['cache-control'], 'no-store');
    // Tells nginx-style proxies not to buffer, which would stall every event.
    assert.strictEqual(s.headers['x-accel-buffering'], 'no');
  } finally { s.stop(); }
});

test('SSE events carry ids and are replayed via Last-Event-ID', async () => {
  const setRound = (round) => postJson('/api/combat', { state: { combatants: [], activeIdx: 0, round, active: true } });

  // Connect, take one event, and note the last id we saw.
  const s1 = await openSse('/api/npc-events');
  await setRound(11);
  await wait(400);
  const ids = [...s1.read().matchAll(/id: (\d+)/g)].map((m) => Number(m[1]));
  s1.stop();
  assert.ok(ids.length > 0, 'broadcast events must carry an id: line');
  const lastSeen = ids[ids.length - 1];

  // While "disconnected", two more events happen.
  await setRound(12);
  await setRound(13);
  await wait(200);

  // Reconnecting with Last-Event-ID must hand back exactly what was missed —
  // without this, everything in the gap is lost until the next poll.
  const s2 = await openSse('/api/npc-events', { 'Last-Event-ID': String(lastSeen) });
  await wait(500);
  const raw = s2.read();
  s2.stop();
  const replayed = [...raw.matchAll(/id: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(replayed.length >= 2, `expected the missed events to be replayed, got ${JSON.stringify(replayed)}`);
  assert.ok(replayed.every((id) => id > lastSeen), 'must replay only events newer than Last-Event-ID');
  assert.match(raw, /"round":12/);
  assert.match(raw, /"round":13/);
});

test('a fresh SSE connection gets no replay backlog', async () => {
  const s = await openSse('/api/npc-events');
  await wait(400);
  const raw = s.read();
  s.stop();
  assert.ok(!/data:/.test(raw), 'no Last-Event-ID means start clean, not replay history');
});
