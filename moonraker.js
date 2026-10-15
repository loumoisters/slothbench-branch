// moonraker.js
// One Klipper printer through Moonraker's HTTP API (the Snapmaker U1, and
// any Voron, Sovol, Creality K-series or other Klipper machine): one GET
// of the printer objects every time the bridge asks. Default port 7125. An
// API key is only needed if the printer has [authorization] set.
//
// With "allowControl": true in its bridge config it can also pause, resume
// and cancel, switch a power device named light / led / lamp, and upload a
// .gcode the app sent and start it (commands.js decides when).

const http = require('http');
const { friendlyNetError } = require('./mqtt');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const STATES = { standby: 'idle', printing: 'printing', paused: 'paused', complete: 'finished', cancelled: 'idle', error: 'failed' };

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers, timeout: 8000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 2_000_000) req.destroy(new Error('Response too large')); });
      res.on('end', () => {
        if (res.statusCode === 401 || res.statusCode === 403) return reject(new Error('Moonraker refused the request (check the API key)'));
        if (res.statusCode !== 200) return reject(new Error(`Moonraker answered ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Moonraker sent something that is not JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer within 8 seconds')));
    req.on('error', (err) => reject(err.code ? new Error(friendlyNetError(err, new URL(url).hostname, new URL(url).port)) : err));
  });
}

// Any Moonraker call: { status, body (Buffer) }.
function request(method, url, { headers = {}, body = null, timeout = 15000, maxBytes = 2_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { 'Content-Length': body.length } : {}) }, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size > maxBytes) { req.destroy(new Error('Response too large')); return; } chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('No answer from Moonraker in time')));
    req.on('error', (err) => reject(err.code ? new Error(friendlyNetError(err, new URL(url).hostname, new URL(url).port)) : err));
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(buf) { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }

// Moonraker keeps uploads under gcodes/; a plain, short name.
function remoteName(name) {
  let n = String(name || 'print.gcode').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  if (!/\.gcode$/i.test(n)) n = n.slice(0, 114) + '.gcode';
  return n;
}

function snapshotFromStatus(st) {
  const ps = st.print_stats || {};
  const ds = st.display_status || {};
  const sd = st.virtual_sdcard || {};
  const progress = num(ds.progress) != null ? num(ds.progress) : num(sd.progress);
  const duration = num(ps.print_duration) || 0;
  const state = STATES[String(ps.state || '').toLowerCase()] || (ps.state ? String(ps.state).toLowerCase() : 'unknown');
  // Moonraker reports how long it has printed, not how long is left; the
  // usual estimate is elapsed / progress - elapsed.
  const remaining = state === 'printing' && progress > 0.01 ? Math.round((duration / progress - duration) / 60) : null;
  const info = ps.info || {};
  return {
    state,
    progress: progress == null ? null : Math.round(progress * 1000) / 10,
    remainingMinutes: remaining,
    job: String(ps.filename || ''),
    layer: num(info.current_layer), totalLayers: num(info.total_layer),
    nozzleTemp: num(st.extruder && st.extruder.temperature), nozzleTarget: num(st.extruder && st.extruder.target),
    bedTemp: num(st.heater_bed && st.heater_bed.temperature), bedTarget: num(st.heater_bed && st.heater_bed.target),
    chamberTemp: null,
    error: state === 'failed' ? String(ps.message || 'Printer error') : '',
    ams: [],
  };
}

class MoonrakerPrinter {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.key = `moonraker:${cfg.host}:${cfg.port || 7125}`;
    this.last = null;
    this.lastError = '';
    this.lastOkAt = 0;
  }

  async start() { await this.refresh(); }

  base() { return `http://${this.cfg.host}:${this.cfg.port || 7125}`; }
  authHeaders() { return this.cfg.apiKey ? { 'X-Api-Key': String(this.cfg.apiKey) } : {}; }

  capabilities() {
    const on = !!this.cfg.allowControl;
    return { control: on, set_filament: false, print_file: on, camera: this.cfg.camera !== false && !this.cameraResting };
  }

  // The webcam picture address: webcamUrl in the config, or the usual one.
  snapshotUrl() { return this.cfg.webcamUrl || `http://${this.cfg.host}/webcam/?action=snapshot`; }

  async _post(pathAndQuery, what) {
    const res = await request('POST', this.base() + pathAndQuery, { headers: this.authHeaders() });
    if (res.status === 401 || res.status === 403) throw new Error('Moonraker refused the request (check the API key)');
    if (res.status !== 200) {
      const j = parseJson(res.body);
      throw new Error(`${what}: Moonraker answered ${res.status}${j && j.error && j.error.message ? ` (${String(j.error.message).slice(0, 120)})` : ''}`);
    }
    return parseJson(res.body);
  }

  async runCommand(command, args = {}) {
    if (command === 'pause' || command === 'resume') return this._post(`/printer/print/${command}`, command === 'pause' ? 'Pause' : 'Resume');
    if (command === 'stop') return this._post('/printer/print/cancel', 'Stop');
    if (command === 'light') {
      const res = await request('GET', this.base() + '/machine/device_power/devices', { headers: this.authHeaders() });
      const j = res.status === 200 ? parseJson(res.body) : null;
      const list = (j && j.result && j.result.devices) || [];
      const dev = list.find((d) => /light|led|lamp/i.test(String(d && d.device)));
      if (!dev) throw new Error('No power device named light, led or lamp on this printer');
      return this._post(`/machine/device_power/device?device=${encodeURIComponent(dev.device)}&action=${args.on ? 'on' : 'off'}`, 'Light');
    }
    if (command === 'set_filament') throw new Error('Setting filament slots only works on Bambu Lab printers');
    throw new Error('This copy of Branch does not know that command');
  }

  // Uploads the .gcode with print=true. A print Moonraker only queued
  // (the printer was busy) counts as failed.
  async printFile(data, args) {
    await this.refresh();
    if (this.last && ['printing', 'paused'].includes(this.last.state)) throw new Error('The printer is busy');
    const boundary = `----jpi${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const body = Buffer.concat([
      Buffer.from(field('root', 'gcodes') + field('print', 'true')),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${remoteName(args.fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await request('POST', this.base() + '/server/files/upload', { headers: { ...this.authHeaders(), 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body, timeout: 10 * 60 * 1000 });
    if (res.status === 401 || res.status === 403) throw new Error('Moonraker refused the upload (check the API key)');
    if (res.status !== 200 && res.status !== 201) throw new Error(`Moonraker answered ${res.status} to the upload`);
    const j = parseJson(res.body) || {};
    const r = j.result || j;
    if (r.print_queued) throw new Error('Moonraker queued the print instead of starting it (was the printer busy?)');
    if (r.print_started !== true) throw new Error('Moonraker took the file but did not start the print');
    return 'ok';
  }

  async refresh() {
    const c = this.cfg;
    const url = `http://${c.host}:${c.port || 7125}/printer/objects/query?print_stats&display_status&virtual_sdcard&extruder&heater_bed`;
    try {
      const body = await getJson(url, c.apiKey ? { 'X-Api-Key': String(c.apiKey) } : {});
      this.last = snapshotFromStatus((body && body.result && body.result.status) || {});
      this.lastOkAt = Date.now();
      this.lastError = '';
    } catch (err) {
      if (this.lastError !== err.message) this.log(`${c.name || c.host}: ${err.message}`);
      this.lastError = err.message;
    }
  }

  snapshot() {
    const online = !!this.last && Date.now() - this.lastOkAt < 60000;
    const base = { key: this.key, name: this.cfg.name || this.cfg.host, type: 'moonraker', model: this.cfg.model || '', online, lastError: online ? '' : (this.lastError || 'no data yet'), capabilities: this.capabilities() };
    return online ? { ...base, ...this.last } : { ...base, state: 'offline' };
  }

  stop() {}
}

module.exports = { MoonrakerPrinter, snapshotFromStatus, remoteName, request };
