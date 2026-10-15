// test/version.test.js
// Branch and the app are released apart, so Branch says its version on
// every report and listens to what the app answers: a newer Branch is out
// (said once), or this one is too old (the app's message is shown).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createBridge, validateConfig, VERSION } = require('../slothbench-branch');

// A stand-in for the app's report address that answers with `reply`.
async function fakeApp(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push(JSON.parse(body || '{}'));
      res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/api/bridge/report`, seen, close: () => new Promise((r) => server.close(r)) };
}

function bridgeFor(url, logs) {
  const cfg = validateConfig({ reportUrl: url, key: 'k'.repeat(32), name: 'Test PC', printers: [{ type: 'moonraker', name: 'Shop U1', host: '127.0.0.1', port: 1 }] });
  return createBridge(cfg, { log: (m) => logs.push(m) });
}

test('every report carries the version', async () => {
  const app = await fakeApp({ body: { ok: true } });
  try {
    await bridgeFor(app.url, []).report();
    assert.equal(app.seen[0].bridge.version, VERSION);
  } finally { await app.close(); }
});

test('a newer Branch from the app is said once, with where to get it', async () => {
  const app = await fakeApp({ body: { ok: true, branch: { latest: '99.0.0', minimum: '1.0.0', download: 'https://example.test/branch' } } });
  try {
    const logs = [];
    const b = bridgeFor(app.url, logs);
    await b.report();
    await b.report();
    const told = logs.filter((m) => m.includes('99.0.0'));
    assert.equal(told.length, 1);
    assert.match(told[0], /https:\/\/example\.test\/branch/);
    assert.match(told[0], /branch\.config\.json/);
  } finally { await app.close(); }
});

test('the same or an older version from the app says nothing', async () => {
  const app = await fakeApp({ body: { ok: true, branch: { latest: VERSION, download: 'https://example.test/branch' } } });
  try {
    const logs = [];
    await bridgeFor(app.url, logs).report();
    assert.equal(logs.length, 0);
  } finally { await app.close(); }
});

test('too old for the app: the app\'s own message is the error', async () => {
  const app = await fakeApp({ status: 426, body: { error: 'Branch 1.0.0 is too old for this app. Download Branch 2.0.0 from https://example.test/branch' } });
  try {
    await assert.rejects(bridgeFor(app.url, []).report(), /too old for this app.*example\.test/);
  } finally { await app.close(); }
});
