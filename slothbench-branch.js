#!/usr/bin/env node
// slothbench-branch.js
// Branch, the Slothbench printer program (formerly the printer bridge): runs on a computer on the same network as
// your printers (the shop PC, a Raspberry Pi, a NAS), reads what each
// printer is doing, and reports it to your Slothbench shop so the
// Printers page and the Dashboard show it live. When a print ends it
// reports that too, so the app keeps a print history and adds real print
// time to the printer. While a printer is printing it also sends a camera
// picture now and then (turn off with "camera": false).
//
// Read-only unless you say otherwise: a printer whose entry in the config
// has "allowControl": true also takes pause / resume / stop / light / set
// filament / print commands from the app (commands.js). Branch
// only ever calls out to the app; it never listens for connections.
//
//   node slothbench-branch.js                 run, using branch.config.json
//                                                     (or an older bridge.config.json)
//   node slothbench-branch.js --config x.json run with another config
//   node slothbench-branch.js --once          read every printer once, print what it saw,
//                                                     send it to the app, and exit (setup check)
//   node slothbench-branch.js --once --dry-run   same, without sending
//   node slothbench-branch.js --help          show these options
//
// Setup and the config file: README.md. Needs Node 20 or later and
// nothing else. Printer passwords (access codes, API keys) stay in the
// config file on this computer; the app only ever receives status.

const fs = require('fs');
const path = require('path');
const { BambuPrinter } = require('./bambu');
const { MoonrakerPrinter } = require('./moonraker');
const { createCommandRunner } = require('./commands');
const camera = require('./camera');

const VERSION = '1.2.0';
const SNAPSHOT_WATCHED_MS = 30 * 1000;
const SNAPSHOT_IDLE_MS = 10 * 60 * 1000;
const CAMERA_REST_MS = 10 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

function loadConfig(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`Cannot read the config file ${file}. Copy branch.config.example.json to branch.config.json and fill it in.`); }
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
  return validateConfig(cfg);
}

function validateConfig(cfg) {
  const problems = [];
  if (!cfg || typeof cfg !== 'object') throw new Error('The config must be a JSON object');
  const reportUrl = String(cfg.reportUrl || '');
  if (!/^https?:\/\/.+\/api\/bridge\/report$/.test(reportUrl)) problems.push('reportUrl: copy the "Report address" from Settings > Integrations > Branch');
  else {
    // The key rides on every report; plain http would hand it to anyone on
    // the way. Only a server on this same machine may skip https.
    let host = '';
    try { host = new URL(reportUrl).hostname; } catch (e) { host = ''; }
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
    if (reportUrl.startsWith('http://') && !local) problems.push('reportUrl: must start with https:// (http:// is only allowed for a server on this same computer)');
  }
  if (String(cfg.key || '').length < 16) problems.push('key: copy the Branch key from Settings > Integrations > Branch');
  if (!Array.isArray(cfg.printers) || !cfg.printers.length) problems.push('printers: list at least one printer');
  (cfg.printers || []).forEach((p, i) => {
    const where = `printers[${i}]${p && p.name ? ` (${p.name})` : ''}`;
    if (!p || !['bambu', 'moonraker'].includes(p.type)) problems.push(`${where}: type must be "bambu" or "moonraker"`);
    else if (!p.host) problems.push(`${where}: host (the printer's IP address) is missing`);
    else if (p.type === 'bambu' && (!p.serial || !p.accessCode)) problems.push(`${where}: a Bambu printer needs its serial number and access code`);
    if (p && 'allowControl' in p && typeof p.allowControl !== 'boolean') problems.push(`${where}: allowControl must be true or false`);
    if (p && 'camera' in p && typeof p.camera !== 'boolean') problems.push(`${where}: camera must be true or false`);
    if (p && p.webcamUrl && !/^https?:\/\//.test(String(p.webcamUrl))) problems.push(`${where}: webcamUrl must start with http:// or https://`);
  });
  if (problems.length) throw new Error(`Branch's settings file needs fixing:\n  - ${problems.join('\n  - ')}`);
  return { intervalSeconds: 10, name: require('os').hostname(), ...cfg };
}

function createBridge(cfg, opts = {}) {
  const log = opts.log || ((msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`));
  const printers = cfg.printers.map((p) => (p.type === 'bambu' ? new BambuPrinter(p, log) : new MoonrakerPrinter(p, log)));
  let timer = null;
  let lastPostError = '';
  let ticks = 0;

  // Pacing: the app's reply says whether someone is looking (watched) and
  // how often it wants telemetry (pollAfterMs: 10 s watched, 60 s not).
  // A change that matters (state, file, error, spools, capabilities) is
  // sent at once; everything is sent at least every 60 s.
  const pace = { watched: false, pollAfterMs: null }; // null: an older app - every tick
  let lastReportAt = 0;
  let lastSignature = '';
  const signature = (snaps) => JSON.stringify(snaps.map((s) => [s.key, s.online, s.state, s.job, s.error, (s.ams || []).map((t) => [t.type, t.color]), s.capabilities]));
  // The app says which Branch is current (lib/branch-version.js on the
  // server). Said once per newer version, not every report.
  let toldUpdate = '';
  function takeVersion(reply) {
    const b = reply && reply.branch;
    if (!b || typeof b.latest !== 'string' || !newer(b.latest, VERSION) || toldUpdate === b.latest) return;
    toldUpdate = b.latest;
    log(`Branch ${b.latest} is out (this is ${VERSION}). Get it from ${String(b.download || '').slice(0, 200)} and replace these files, keeping branch.config.json.`);
  }

  function takePacing(reply) {
    if (reply && typeof reply.watched === 'boolean') {
      pace.watched = reply.watched;
      const ms = Number(reply.pollAfterMs);
      pace.pollAfterMs = Number.isFinite(ms) ? Math.min(HEARTBEAT_MS, Math.max(3000, ms)) : HEARTBEAT_MS;
    }
  }

  // Print history: the bridge notes when each printer starts printing and,
  // when it leaves printing/paused, posts what happened to the app
  // (POST .../api/bridge/history). Still read-only - it only reports what
  // it saw. A post that fails is retried after 2, 8 and 30 s and dropped
  // once it is 5 minutes old.
  const historyUrl = String(cfg.reportUrl).replace(/\/report$/, '/history');
  const retryMs = opts.historyRetryMs || [2000, 8000, 30000];
  const historyMaxAgeMs = opts.historyMaxAgeMs || 5 * 60 * 1000;
  const active = new Map(); // printer key -> { startedAt, job }
  const outbox = [];        // { body, firstAt, attempts, nextAt }
  let retryTimer = null;

  function watchRuns(snaps, now = Date.now()) {
    for (const s of snaps) {
      if (!s || !s.key) continue;
      const printing = s.state === 'printing' || s.state === 'paused';
      const cur = active.get(s.key);
      if (printing) {
        if (!cur) active.set(s.key, { startedAt: now, job: s.job || '' });
        else if (s.job && !cur.job) cur.job = s.job;
        continue;
      }
      // Offline or unknown is not an ending: wait until the printer says.
      if (!cur || !s.online || s.state === 'offline' || s.state === 'unknown') continue;
      active.delete(s.key);
      const result = s.state === 'finished' ? 'finished' : s.state === 'failed' ? 'error' : 'cancelled';
      outbox.push({
        body: { printerKey: s.key, job: cur.job || s.job || '', startedAt: new Date(cur.startedAt).toISOString(), endedAt: new Date(now).toISOString(), durationSeconds: Math.max(0, Math.round((now - cur.startedAt) / 1000)), result },
        firstAt: now, attempts: 0, nextAt: now,
      });
      log(`${s.name || s.key}: print ${result === 'finished' ? 'finished' : result === 'error' ? 'ended with an error' : 'stopped'}${cur.job ? ` ("${cur.job}")` : ''}`);
    }
  }

  async function flushHistory(now = Date.now()) {
    if (opts.dryRun) { outbox.length = 0; return; }
    for (const item of outbox.slice()) {
      if (item.nextAt > now) continue;
      let ok = false;
      try {
        const res = await fetch(historyUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': cfg.key }, body: JSON.stringify(item.body) });
        ok = res.ok;
      } catch (err) { ok = false; }
      if (ok) { outbox.splice(outbox.indexOf(item), 1); continue; }
      item.attempts += 1;
      if (item.attempts > retryMs.length || now - item.firstAt >= historyMaxAgeMs) {
        outbox.splice(outbox.indexOf(item), 1);
        log(`Gave up sending a finished print to the app (${item.body.job || item.body.printerKey})`);
        continue;
      }
      item.nextAt = now + retryMs[item.attempts - 1];
      if (timer && !retryTimer) {
        retryTimer = setTimeout(() => { retryTimer = null; flushHistory(); }, retryMs[item.attempts - 1]);
        if (retryTimer.unref) retryTimer.unref();
      }
    }
  }

  // ---------- Camera pictures ----------
  // Only while a printer prints or is paused: every 30 s while someone is
  // looking, every 10 min otherwise. Three failures in a row (an X1/H2/P2S
  // camera the bridge cannot read, say) rest the camera for 10 minutes.
  const snapshotUrl = String(cfg.reportUrl).replace(/\/report$/, '/snapshot');
  const cam = new Map(); // printer key -> { nextAt, fails, restUntil, busy }
  async function grab(p) {
    if (p instanceof BambuPrinter) return camera.bambuFrame({ host: p.cfg.host, port: p.cfg.cameraPort || 6000, accessCode: p.cfg.accessCode });
    return camera.httpSnapshot(p.snapshotUrl());
  }
  async function snapshotTick(now = Date.now()) {
    const jobs = [];
    for (const p of printers) {
      const c = cam.get(p.key) || { nextAt: 0, fails: 0, restUntil: 0, busy: null };
      cam.set(p.key, c);
      if (c.busy) { jobs.push(c.busy); continue; } // a picture on its way
      if (p.cameraResting && c.restUntil <= now) p.cameraResting = false;
      const s = p.snapshot();
      if (p.cfg.camera === false || p.cameraResting || !s.online || !['printing', 'paused'].includes(s.state) || c.nextAt > now) continue;
      c.nextAt = now + (pace.watched ? SNAPSHOT_WATCHED_MS : SNAPSHOT_IDLE_MS);
      c.busy = (async () => {
        try {
          const jpeg = await grab(p);
          c.fails = 0;
          if (opts.dryRun) return;
          const res = await fetch(snapshotUrl, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Api-Key': cfg.key, 'X-Printer-Key': p.key }, body: jpeg });
          if (!res.ok) log(`${p.cfg.name || p.key}: the app did not take the camera picture (${res.status})`);
        } catch (err) {
          c.fails += 1;
          if (c.fails >= 3) {
            c.fails = 0;
            c.restUntil = now + CAMERA_REST_MS;
            p.cameraResting = true;
            log(`${p.cfg.name || p.key}: no camera picture 3 times (${err.message}); trying again in 10 minutes`);
          }
        } finally { c.busy = null; }
      })();
      jobs.push(c.busy);
    }
    return Promise.all(jobs);
  }

  // ---------- Commands (only with allowControl on some printer) ----------
  const runner = createCommandRunner({ cfg, printers, log, version: VERSION, fetchImpl: opts.fetchImpl || fetch, ackRetryMs: opts.ackRetryMs });
  let pollTimer = null;
  let lastPollError = '';
  async function pollLoop() {
    let next = 30000;
    try {
      const r = await runner.pollOnce();
      pace.watched = r.watched;
      next = r.pollAfterMs;
      if (lastPollError) log('Asking the app for commands again');
      lastPollError = '';
    } catch (err) {
      if (err.message !== lastPollError) log(`Could not ask the app for commands: ${err.message}`);
      lastPollError = err.message;
      next = err.status === 401 ? 5 * 60 * 1000 : 30000;
    }
    if (timer) { pollTimer = setTimeout(pollLoop, next); if (pollTimer.unref) pollTimer.unref(); }
  }

  async function report() {
    const body = { bridge: { name: String(cfg.name || 'Branch'), version: VERSION }, printers: printers.map((p) => p.snapshot()) };
    const res = await fetch(cfg.reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': cfg.key },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 426: this Branch is too old for the app; the app says where to update.
      if (res.status === 426) { let msg = ''; try { msg = String(JSON.parse(text).error || ''); } catch (e) { /* not JSON */ } throw new Error(msg.slice(0, 300) || 'the app needs a newer Branch'); }
      throw new Error(res.status === 401 ? 'the app refused the Branch key (regenerated? copy the new one)' : `the app answered ${res.status} ${text.slice(0, 120)}`);
    }
    const reply = await res.json().catch(() => ({}));
    takePacing(reply);
    takeVersion(reply);
    lastReportAt = Date.now();
    lastSignature = signature(body.printers);
    return reply;
  }

  async function tick(now = Date.now()) {
    ticks += 1;
    // Klipper is polled every tick; Bambu pushes on its own, and gets a
    // full refresh every 5 minutes in case a partial update was missed.
    await Promise.all(printers.filter((p) => p instanceof MoonrakerPrinter).map((p) => p.refresh()));
    if (ticks % 30 === 0) printers.forEach((p) => p.refresh && p instanceof BambuPrinter && p.refresh());
    const snaps = printers.map((p) => p.snapshot());
    watchRuns(snaps);
    if (outbox.length) await flushHistory();
    snapshotTick(now);
    if (opts.dryRun) return null;
    const due = !lastReportAt || pace.pollAfterMs == null || signature(snaps) !== lastSignature || now - lastReportAt >= pace.pollAfterMs - 500;
    if (!due) return null;
    try {
      const out = await report();
      if (lastPostError) log('Reporting to the app again');
      lastPostError = '';
      return out;
    } catch (err) {
      if (err.message !== lastPostError) log(`Could not report to the app: ${err.message}`);
      lastPostError = err.message;
      return null;
    }
  }

  async function start() {
    const control = printers.filter((p) => p.cfg.allowControl);
    log(`Slothbench Branch ${VERSION}: ${printers.length} printer${printers.length === 1 ? '' : 's'}, reading every ${cfg.intervalSeconds}s${control.length ? `; control on for ${control.map((p) => p.cfg.name || p.key).join(', ')}` : ''}`);
    await Promise.all(printers.map((p) => p.start()));
    await tick();
    timer = setInterval(tick, Math.max(3, Number(cfg.intervalSeconds) || 10) * 1000);
    if (control.length && !opts.dryRun) { pollTimer = setTimeout(pollLoop, 3000); if (pollTimer.unref) pollTimer.unref(); }
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    printers.forEach((p) => p.stop());
  }

  return { start, stop, tick, report, watchRuns, flushHistory, snapshotTick, pollCommands: () => runner.pollOnce(), runner, pace, pendingHistory: () => outbox.map((x) => ({ ...x.body, attempts: x.attempts })), snapshots: () => printers.map((p) => p.snapshot()), printers };
}

function describe(s) {
  if (!s.online) return `${s.name}: OFFLINE (${s.lastError})`;
  const bits = [s.state];
  if (s.progress != null && s.state === 'printing') bits.push(`${Math.round(s.progress)}%`);
  if (s.remainingMinutes != null && s.state === 'printing') bits.push(`${s.remainingMinutes} min left`);
  if (s.job) bits.push(`"${s.job}"`);
  if (s.nozzleTemp != null) bits.push(`nozzle ${Math.round(s.nozzleTemp)}°`);
  if (s.bedTemp != null) bits.push(`bed ${Math.round(s.bedTemp)}°`);
  if (s.ams && s.ams.length) bits.push(`${s.ams.length} spool${s.ams.length === 1 ? '' : 's'} loaded`);
  return `${s.name}: ${bits.join(', ')}`;
}

const HELP = `Branch ${VERSION}: reaches from your Slothbench shop out to your printers.

Usage:
  node slothbench-branch.js                    keep running and report to the app
  node slothbench-branch.js --config x.json    use another settings file
  node slothbench-branch.js --once             read every printer once, send it to the app, and stop (setup check)
  node slothbench-branch.js --once --dry-run   same, without sending
  node slothbench-branch.js --help             show this

Settings live in branch.config.json next to this file (an older bridge.config.json still works).
Setup guide: README.md, or https://github.com/loumoisters/slothbench-branch`;

// branch.config.json; an older bridge.config.json still works if that's all there is.
function defaultConfigFile() {
  const file = path.join(__dirname, 'branch.config.json');
  const old = path.join(__dirname, 'bridge.config.json');
  if (!fs.existsSync(file) && fs.existsSync(old)) return old;
  return file;
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => args.includes(name);
  const ci = args.indexOf('--config');
  if (flag('--help') || flag('-h')) { console.log(HELP); return; }
  const file = ci >= 0 ? path.resolve(args[ci + 1] || '') : defaultConfigFile();
  const cfg = loadConfig(file);
  const bridge = createBridge(cfg, { dryRun: flag('--dry-run') });

  if (flag('--once')) {
    await Promise.all(bridge.printers.map((p) => p.start()));
    // Bambu answers "pushall" within a second or two; give it a few.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && bridge.snapshots().some((s) => !s.online)) await new Promise((r) => setTimeout(r, 500));
    for (const s of bridge.snapshots()) console.log(describe(s));
    if (!flag('--dry-run')) {
      try { await bridge.report(); console.log('Sent to the app.'); }
      catch (err) { console.log(`Could not report to the app: ${err.message}`); process.exitCode = 1; }
    }
    bridge.stop();
    return;
  }

  await bridge.start();
  const shutdown = () => { bridge.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main(process.argv).catch((err) => { console.error(err.message); process.exit(1); });
}

// Is version a newer than b? (x.y.z; anything unreadable is not newer.)
function newer(a, b) {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(String(a));
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(String(b));
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) > Number(pb[i]);
  return false;
}

module.exports = { createBridge, validateConfig, loadConfig, describe, VERSION };
