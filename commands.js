// commands.js
// The bridge's side of the app's command queue: asks the app for commands
// (outbound only - the bridge never listens for connections), runs the
// ones meant for its printers, and answers each one.
//
//   GET  <shop>/api/bridge/commands               -> { commands: [{ id, key, command, args }], watched, pollAfterMs }
//   POST <shop>/api/bridge/commands/:id/ack       { status: running|done|failed, errorMessage }
//
// Rules it keeps, whatever the app sends:
//   - Only these commands exist: pause, resume, stop, light, set_filament,
//     print_file. Anything else is answered "failed" and never run.
//   - A printer only takes commands with "allowControl": true in its own
//     entry in the bridge config.
//   - A command for a printer this bridge does not have is left alone (no
//     answer), so several bridges can share one shop. Every command id is
//     remembered for an hour, so nothing runs twice.
//   - A print file is downloaded only from the app's own address (the host
//     in reportUrl), over https (plain http only to this computer, for
//     tests), without following redirects, up to 60 MB, and its size and
//     sha256 must match what the app said. The download address is never
//     written to the log.

const crypto = require('crypto');

const KNOWN = new Set(['pause', 'resume', 'stop', 'light', 'set_filament', 'print_file']);
const MATERIALS = new Set(['PLA', 'PLA-CF', 'PETG', 'PETG-CF', 'ABS', 'ASA', 'PC', 'PA', 'PA-CF', 'TPU', 'PVA', 'HIPS']);
const MAX_PRINT_BYTES = 60 * 1024 * 1024;
const REMEMBER_MS = 60 * 60 * 1000;
const POLL_MIN_MS = 2000;
const POLL_MAX_MS = 120000;

function clampPoll(ms, fallback) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? Math.min(POLL_MAX_MS, Math.max(POLL_MIN_MS, n)) : fallback;
}

// A print job gets 12 minutes, or 10 minutes plus the file at 20 KB/s.
function jobTimeoutMs(sizeBytes) {
  return Math.max(12 * 60 * 1000, 10 * 60 * 1000 + ((Number(sizeBytes) || 0) / 20480) * 1000);
}

function isLocalHost(hostname) { return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname); }

// Checks a command's arguments; returns clean ones or throws in plain words.
function validateArgs(command, raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (command === 'pause' || command === 'resume' || command === 'stop') return {};
  if (command === 'light') {
    if (typeof a.on !== 'boolean') throw new Error('light needs on: true or false');
    return { on: a.on };
  }
  if (command === 'set_filament') {
    const slot = Number(a.slot);
    if (!Number.isInteger(slot) || !((slot >= 0 && slot <= 63) || slot === 254)) throw new Error('set_filament: bad slot');
    const material = String(a.material || '').toUpperCase();
    if (!MATERIALS.has(material)) throw new Error('set_filament: unknown material');
    const color = String(a.color || '').replace(/^#/, '').toUpperCase();
    if (!/^[0-9A-F]{6}$/.test(color)) throw new Error('set_filament: colour must be RRGGBB');
    return { slot, material, color };
  }
  if (command === 'print_file') {
    const sizeBytes = Number(a.sizeBytes);
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new Error('print_file: bad file size');
    if (sizeBytes > MAX_PRINT_BYTES) throw new Error('The print file is over 60 MB');
    if (!/^[0-9a-f]{64}$/.test(String(a.sha256 || ''))) throw new Error('print_file: bad checksum');
    if (!['gcode', 'gcode_3mf'].includes(a.format)) throw new Error('print_file: unknown file format');
    if (typeof a.downloadUrl !== 'string' || a.downloadUrl.length > 1000) throw new Error('print_file: no download address');
    const plate = Number(a.plate || 1);
    if (!Number.isInteger(plate) || plate < 1 || plate > 64) throw new Error('print_file: bad plate number');
    const mapping = Array.isArray(a.amsMapping) ? a.amsMapping : [];
    if (mapping.length > 32 || mapping.some((v) => !Number.isInteger(v) || v < -1 || v > 254)) throw new Error('print_file: bad AMS mapping');
    return {
      downloadUrl: a.downloadUrl, sha256: a.sha256, sizeBytes, format: a.format, plate,
      fileName: String(a.fileName || 'print').slice(0, 160), subtaskName: String(a.subtaskName || '').slice(0, 100),
      useAms: a.useAms === true, amsMapping: mapping, bedLeveling: a.bedLeveling !== false, timelapse: a.timelapse === true,
    };
  }
  throw new Error('This copy of Branch does not know that command');
}

function createCommandRunner({ cfg, printers, log, version, fetchImpl = fetch, ackRetryMs = [2000, 5000, 10000, 20000, 30000, 30000, 30000, 30000] }) {
  const commandsUrl = String(cfg.reportUrl).replace(/\/report$/, '/commands');
  const appOrigin = new URL(cfg.reportUrl).origin;
  const seen = new Map(); // command id -> forget after
  const jobs = new Set(); // printer keys with a print job running
  const headers = () => ({
    'X-Api-Key': cfg.key,
    'X-Bridge-Name': String(cfg.name || 'Branch').slice(0, 60),
    'X-Bridge-Version': String(version || ''),
    'X-Bridge-Capabilities': 'control,set_filament,print_file,camera',
  });

  async function ack(id, status, errorMessage) {
    const res = await fetchImpl(`${commandsUrl}/${encodeURIComponent(id)}/ack`, {
      method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, ...(errorMessage ? { errorMessage: String(errorMessage).slice(0, 500) } : {}) }),
    });
    return res.status;
  }

  // The final answer matters (the app waits for it): retried for about 3 minutes.
  async function finalAck(id, status, errorMessage) {
    for (let i = 0; i <= ackRetryMs.length; i++) {
      try {
        const st = await ack(id, status, errorMessage);
        if (st === 200 || st === 404) return st;
      } catch (err) { /* network: try again */ }
      if (i < ackRetryMs.length) await new Promise((r) => setTimeout(r, ackRetryMs[i]));
    }
    log(`Could not tell the app how a command ended (${id})`);
    return null;
  }

  // Downloads the file the app named, from the app only.
  async function download(args) {
    let url;
    try { url = new URL(args.downloadUrl); } catch { throw new Error('The download address is not valid'); }
    if (url.origin !== appOrigin) throw new Error('The download address is not on the app\'s own host');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) throw new Error('Downloads must use https');
    let res;
    try { res = await fetchImpl(url, { headers: { 'X-Api-Key': cfg.key }, redirect: 'manual' }); } catch (err) { throw new Error('Could not download the print file from the app'); }
    if (res.status >= 300 && res.status < 400) throw new Error('The download tried to redirect; refused');
    if (res.status !== 200) throw new Error(`The app answered ${res.status} to the download (it may have expired)`);
    const declared = Number(res.headers.get('content-length'));
    if (declared && declared !== args.sizeBytes) throw new Error('The print file is not the size the app said');
    const chunks = [];
    let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > args.sizeBytes || size > MAX_PRINT_BYTES) { try { await reader.cancel(); } catch { /* gone */ } throw new Error('The print file is bigger than the app said'); }
      chunks.push(Buffer.from(value));
    }
    const data = Buffer.concat(chunks, size);
    if (size !== args.sizeBytes) throw new Error('The print file is not the size the app said');
    if (crypto.createHash('sha256').update(data).digest('hex') !== args.sha256) throw new Error('The print file\'s checksum does not match');
    return data;
  }

  async function runPrint(printer, cmd, args) {
    if (jobs.has(printer.key)) { await finalAck(cmd.id, 'failed', 'This printer is already receiving a print'); return; }
    if ((printer.cfg.type === 'bambu') !== (args.format === 'gcode_3mf')) {
      await finalAck(cmd.id, 'failed', args.format === 'gcode_3mf' ? 'A .gcode.3mf only prints on a Bambu Lab printer' : 'A plain .gcode only prints on a Klipper printer');
      return;
    }
    let st;
    try { st = await ack(cmd.id, 'running'); } catch (err) { st = 0; }
    if (st === 404) { log(`${printer.cfg.name || printer.key}: a print was taken by another copy of Branch or expired; skipped`); return; }
    jobs.add(printer.key);
    let timer;
    try {
      const work = (async () => {
        const data = await download(args);
        log(`${printer.cfg.name || printer.key}: sending "${args.fileName}" to the printer`);
        await printer.printFile(data, args);
      })();
      await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The print job took too long')), jobTimeoutMs(args.sizeBytes)); })]);
      log(`${printer.cfg.name || printer.key}: print started`);
      await finalAck(cmd.id, 'done');
    } catch (err) {
      log(`${printer.cfg.name || printer.key}: print not started: ${err.message}`);
      await finalAck(cmd.id, 'failed', err.message);
    } finally {
      clearTimeout(timer);
      jobs.delete(printer.key);
    }
  }

  async function run(printer, cmd) {
    if (!KNOWN.has(cmd.command)) { await finalAck(cmd.id, 'failed', 'This copy of Branch does not know that command'); return; }
    if (!printer.cfg.allowControl) { await finalAck(cmd.id, 'failed', 'Control is off for this printer in Branch (allowControl in branch.config.json)'); return; }
    let args;
    try { args = validateArgs(cmd.command, cmd.args); } catch (err) { await finalAck(cmd.id, 'failed', err.message); return; }
    const caps = printer.capabilities ? printer.capabilities() : {};
    const need = cmd.command === 'print_file' ? 'print_file' : cmd.command === 'set_filament' ? 'set_filament' : 'control';
    if (!caps[need]) { await finalAck(cmd.id, 'failed', 'The printer refused this kind of command recently (Bambu: needs LAN Only Mode with Developer Mode). Try again later.'); return; }
    if (cmd.command === 'print_file') { await runPrint(printer, cmd, args); return; }
    try {
      await printer.runCommand(cmd.command, args);
      log(`${printer.cfg.name || printer.key}: ${cmd.command} done`);
      await finalAck(cmd.id, 'done');
    } catch (err) {
      log(`${printer.cfg.name || printer.key}: ${cmd.command} failed: ${err.message}`);
      await finalAck(cmd.id, 'failed', err.message);
    }
  }

  // One poll. Returns the app's pacing hints, and the work it started
  // (tests await it).
  async function pollOnce(now = Date.now()) {
    for (const [id, until] of seen) if (until < now) seen.delete(id);
    const res = await fetchImpl(commandsUrl, { headers: headers() });
    if (res.status === 401) { const e = new Error('the app refused the Branch key'); e.status = 401; throw e; }
    if (res.status === 426) throw new Error('the app needs a newer Branch for printer commands (see the report message)');
    if (!res.ok) throw new Error(`the app answered ${res.status} to the command poll`);
    const body = await res.json().catch(() => ({}));
    const work = [];
    for (const cmd of Array.isArray(body.commands) ? body.commands.slice(0, 50) : []) {
      if (!cmd || typeof cmd !== 'object' || !/^[A-Za-z0-9_-]{1,100}$/.test(String(cmd.id || '')) || typeof cmd.command !== 'string') continue;
      if (seen.has(cmd.id)) continue;
      seen.set(cmd.id, now + REMEMBER_MS);
      const printer = printers.find((p) => p.key === cmd.key);
      if (!printer) continue; // another bridge's printer: leave it unanswered
      work.push(run(printer, cmd));
    }
    return { watched: body.watched === true, pollAfterMs: clampPoll(body.pollAfterMs, 4000), work: Promise.all(work) };
  }

  return { pollOnce, download, ack, finalAck, seen, jobs };
}

module.exports = { createCommandRunner, validateArgs, jobTimeoutMs, clampPoll, KNOWN, MAX_PRINT_BYTES };
