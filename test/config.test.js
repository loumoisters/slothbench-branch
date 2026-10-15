// test/config.test.js
// Branch's config check (validateConfig): the report address must be https
// unless the app runs on the same computer, since the Branch key rides on
// every report.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateConfig } = require('../slothbench-branch');

const base = { key: 'k'.repeat(32), printers: [{ type: 'moonraker', name: 'Shop U1', host: '192.168.1.50' }] };
const check = (reportUrl) => { try { validateConfig({ ...base, reportUrl }); return 'ok'; } catch (err) { return err.message; } };

test('config: plain http is only for a server on this computer', () => {
  assert.equal(check('https://slothbench.app/api/bridge/report'), 'ok');
  assert.equal(check('http://localhost:3000/api/bridge/report'), 'ok');
  assert.equal(check('http://127.0.0.1:3000/api/bridge/report'), 'ok');
  assert.match(check('http://slothbench.app/api/bridge/report'), /https/);
  assert.match(check('http://192.168.1.10:3000/api/bridge/report'), /https/);
  assert.match(check('ftp://slothbench.app/api/bridge/report'), /reportUrl/);
});
