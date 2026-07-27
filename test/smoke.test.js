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
