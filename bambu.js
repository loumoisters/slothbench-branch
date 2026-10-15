// bambu.js
// One Bambu Lab printer over its local MQTT feed (the same feed Bambu
// Studio and Home Assistant read). The bridge connects with the printer's
// serial number and LAN access code (both on the printer's screen),
// subscribes to device/<serial>/report, asks once for a full status
// ("pushall"), and then keeps the merged state as partial updates arrive -
// P1 and A1 printers only send what changed.
//
// Reading is all it does unless the printer's bridge config has
// "allowControl": true. Then it can also pause, resume, stop, switch the
// light, set an AMS slot's filament and start a print the app sent
// (runCommand / printFile below; commands.js decides when). Current
// Bambu firmware refuses all of that unless the printer is in LAN Only
// Mode with Developer Mode on - Bambu's rule. When the printer refuses,
// the bridge stops offering that capability for 30 minutes.

const { MqttClient } = require('./mqtt');
const ftps = require('./ftps');

const STATES = {
  IDLE: 'idle', PREPARE: 'preparing', SLICING: 'preparing', RUNNING: 'printing',
  PAUSE: 'paused', FINISH: 'finished', FAILED: 'failed', OFFLINE: 'offline',
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// Bambu sends partial objects; arrays of trays/units are keyed by "id".
function merge(into, from) {
  for (const [k, v] of Object.entries(from || {})) {
    if (Array.isArray(v) && Array.isArray(into[k]) && v.every((x) => isObj(x) && 'id' in x)) {
      const byId = new Map(into[k].map((x) => [String(x.id), x]));
      for (const x of v) byId.set(String(x.id), merge({ ...(byId.get(String(x.id)) || {}) }, x));
      into[k] = [...byId.values()];
    } else if (isObj(v) && isObj(into[k])) {
      into[k] = merge({ ...into[k] }, v);
    } else {
      into[k] = v;
    }
  }
  return into;
}

// Two-nozzle printers (H2D and its kin), by serial number prefix. They
// also have a second chamber light.
const DUAL_NOZZLE_PREFIXES = ['094', '239', '31B', '20P'];
function isDualNozzle(serial) { return DUAL_NOZZLE_PREFIXES.some((p) => String(serial || '').toUpperCase().startsWith(p)); }

// Bambu's generic filament profile per material, for "set this slot":
// [profile id, lowest and highest nozzle temperature].
const FILAMENT_PROFILES = {
  PLA: ['GFL99', 190, 230], 'PLA-CF': ['GFL98', 210, 240], PETG: ['GFG99', 220, 260], 'PETG-CF': ['GFG98', 240, 270],
  ABS: ['GFB99', 240, 270], ASA: ['GFB98', 240, 270], PC: ['GFC99', 260, 280], PA: ['GFN99', 260, 290],
  'PA-CF': ['GFN98', 260, 290], TPU: ['GFU99', 200, 240], PVA: ['GFS99', 190, 230], HIPS: ['GFS98', 220, 260],
};

const CAPABILITY_REST_MS = 30 * 60 * 1000;
const REMOTE_NAME = 'slothbench-print.gcode.3mf';
const BUSY = ['printing', 'paused', 'preparing'];

function isReply(part) { return !!(part && part.command && part.command !== 'push_status' && 'result' in part); }

function trayColor(c) {
  const m = /^([0-9a-fA-F]{6})/.exec(String(c || ''));
  return m ? `#${m[1].toLowerCase()}` : '';
}

// What the app is sent: the same shape for every kind of printer.
function snapshotFromReport(print) {
  const p = print || {};
  const ams = [];
  const units = (p.ams && Array.isArray(p.ams.ams)) ? p.ams.ams : [];
  for (const unit of units) {
    for (const tray of Array.isArray(unit.tray) ? unit.tray : []) {
      if (!tray || (!tray.tray_type && !tray.tray_color)) continue;
      const unitId = Number(unit.id) || 0;
      ams.push({ unit: unitId, slot: Number(tray.id) || 0, type: String(tray.tray_type || ''), color: trayColor(tray.tray_color), remain: num(tray.remain), ...(unitId >= 128 ? { ht: true } : {}) });
    }
  }
  if (p.vt_tray && (p.vt_tray.tray_type || p.vt_tray.tray_color)) {
    ams.push({ unit: -1, slot: 0, type: String(p.vt_tray.tray_type || ''), color: trayColor(p.vt_tray.tray_color), remain: num(p.vt_tray.remain), external: true });
  }
  const raw = String(p.gcode_state || '').toUpperCase();
  const err = num(p.print_error);
  return {
    state: STATES[raw] || (raw ? raw.toLowerCase() : 'unknown'),
    progress: num(p.mc_percent),
    remainingMinutes: num(p.mc_remaining_time),
    job: String(p.subtask_name || p.gcode_file || ''),
    layer: num(p.layer_num),
    totalLayers: num(p.total_layer_num),
    nozzleTemp: num(p.nozzle_temper), nozzleTarget: num(p.nozzle_target_temper),
    bedTemp: num(p.bed_temper), bedTarget: num(p.bed_target_temper),
    chamberTemp: num(p.chamber_temper),
    error: err ? `Printer error ${err.toString(16).toUpperCase()}` : '',
    ams,
  };
}

class BambuPrinter {
  constructor(cfg, log) {
    this.cfg = cfg;
    this.log = log || (() => {});
    this.key = `bambu:${cfg.serial}`;
    this.print = {};
    this.lastReportAt = 0;
    this.lastError = '';
    this.client = null;
    this.stopped = false;
    this.retryMs = 5000;
    this.dropped = new Map(); // capability -> time it may be offered again
    this.waiters = new Set(); // commands waiting for the printer's answer
    this.dualNozzle = isDualNozzle(cfg.serial);
    this.cameraResting = false; // set by the bridge after 3 failed pictures
  }

  // What the bridge offers the app for this printer. Control needs
  // allowControl in the config; a refusal takes a capability away for 30 min.
  capabilities() {
    const on = (cap) => !!this.cfg.allowControl && !((this.dropped.get(cap) || 0) > Date.now());
    return { control: on('control'), set_filament: on('set_filament'), print_file: on('print_file'), camera: this.cfg.camera !== false && !this.cameraResting };
  }
  dropCapability(cap) { this.dropped.set(cap, Date.now() + CAPABILITY_REST_MS); }

  async start() {
    this.stopped = false;
    await this._connect();
  }

  async _connect() {
    if (this.stopped) return;
    const c = this.cfg;
    const client = new MqttClient({ host: c.host, port: c.port || 8883, username: 'bblp', password: String(c.accessCode || ''), transport: c.transport || 'tls' });
    this.client = client;
    client.on('message', (topic, payload) => {
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        // A reply to a command ("command": "pause", "result": "fail", ...)
        // goes to whoever waits for it; status ("push_status") is merged.
        if (msg && isReply(msg.print)) this._answer('print', msg.print);
        if (msg && isReply(msg.system)) this._answer('system', msg.system);
        if (msg && msg.print && !isReply(msg.print)) { merge(this.print, msg.print); this.lastReportAt = Date.now(); this.lastError = ''; }
        for (const w of this.waiters) w.onReport();
      } catch (e) { /* not JSON we understand; ignore */ }
    });
    client.on('error', (err) => { this.lastError = err.message; });
    client.on('close', () => { this._retry('connection closed'); });
    try {
      await client.connect();
      client.subscribe(`device/${c.serial}/report`);
      client.publish(`device/${c.serial}/request`, { pushing: { sequence_id: '0', command: 'pushall' } });
      this.retryMs = 5000;
      this.log(`${c.name || c.serial}: connected`);
    } catch (err) {
      this.lastError = err.message;
      this.log(`${c.name || c.serial}: ${err.message}`);
      client.end();
      this._retry(err.message);
    }
  }

  _retry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this._connect(); }, this.retryMs);
    if (this.retryTimer.unref) this.retryTimer.unref();
    this.retryMs = Math.min(60000, this.retryMs * 2);
  }

  // Ask for a full status again (cheap; the printer answers on the report topic).
  refresh() {
    if (this.client && this.client.connected) this.client.publish(`device/${this.cfg.serial}/request`, { pushing: { sequence_id: '0', command: 'pushall' } });
  }

  // ---------- Control (only with allowControl; see commands.js) ----------

  _answer(section, part) {
    for (const w of this.waiters) if (w.section === section && w.command === part.command) w.reply(part);
  }

  // Publishes a request and waits for the printer's answer, or for its
  // status to show the change (`done()`), whichever comes first.
  _request(section, payload, { command, done, timeoutMs = 10000, quietOk = false } = {}) {
    if (!this.client || !this.client.connected) return Promise.reject(new Error('Branch is not connected to this printer'));
    return new Promise((resolve, reject) => {
      const w = { section, command };
      const finish = (err, v) => { clearTimeout(t); this.waiters.delete(w); if (err) reject(err); else resolve(v); };
      const t = setTimeout(() => (quietOk ? finish(null, 'quiet') : finish(new Error('The printer did not answer'))), timeoutMs);
      w.reply = (part) => {
        if (String(part.result || '').toLowerCase() === 'fail') {
          const err = new Error(`The printer refused${part.reason ? ` (${String(part.reason).slice(0, 160)})` : ''}. Bambu printers only take commands in LAN Only Mode with Developer Mode on.`);
          err.refused = true;
          return finish(err);
        }
        if (!done) finish(null, 'ok');
      };
      w.onReport = () => { if (done && done()) finish(null, 'ok'); };
      this.waiters.add(w);
      this.client.publish(`device/${this.cfg.serial}/request`, { [section]: { sequence_id: '0', command, ...payload } });
    });
  }

  state() { return snapshotFromReport(this.print).state; }

  async runCommand(command, args = {}) {
    try {
      if (command === 'pause' || command === 'resume' || command === 'stop') {
        const want = { pause: (s) => s === 'paused', resume: (s) => s === 'printing', stop: (s) => !BUSY.includes(s) }[command];
        return await this._request('print', {}, { command, done: () => want(this.state()), timeoutMs: 10000 });
      }
      if (command === 'light') {
        const nodes = this.dualNozzle ? ['chamber_light', 'chamber_light2'] : ['chamber_light'];
        for (const node of nodes) {
          await this._request('system', { led_node: node, led_mode: args.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 }, { command: 'ledctrl', timeoutMs: 5000, quietOk: true });
        }
        return 'ok';
      }
      if (command === 'set_filament') return await this._setFilament(args);
      throw new Error('This copy of Branch does not know that command');
    } catch (err) {
      if (err.refused) this.dropCapability(command === 'set_filament' ? 'set_filament' : 'control');
      throw err;
    }
  }

  async _setFilament({ slot, material, color }) {
    const profile = FILAMENT_PROFILES[material];
    if (!profile) throw new Error('Unknown material');
    const external = slot === 254;
    if (external && this.dualNozzle) throw new Error('The outside spool cannot be set on a two-nozzle printer');
    const amsId = external ? 255 : Math.floor(slot / 4);
    const trayId = external ? 254 : slot % 4;
    if (!external && amsId >= 16) throw new Error('AMS HT slots cannot be set from the app yet');
    const hex = String(color).toUpperCase();
    const shows = () => {
      const unit = ((this.print.ams || {}).ams || []).find((u) => Number(u.id) === amsId);
      const t = external ? this.print.vt_tray : unit && (unit.tray || []).find((x) => Number(x.id) === trayId);
      return !!t && String(t.tray_type || '').toUpperCase() === material && String(t.tray_color || '').toUpperCase().startsWith(hex);
    };
    const sent = this._request('print', {
      ams_id: amsId, tray_id: trayId, slot_id: trayId, tray_info_idx: profile[0], tray_type: material,
      tray_color: `${hex}FF`, nozzle_temp_min: profile[1], nozzle_temp_max: profile[2],
    }, { command: 'ams_filament_setting', done: shows, timeoutMs: 6000 });
    setTimeout(() => this.refresh(), 300);
    try { return await sent; } catch (err) {
      if (!err.refused && /did not answer/.test(err.message)) throw new Error('The printer did not show the new filament within 6 seconds');
      throw err;
    }
  }

  // Copies the file to the printer's SD card (FTPS) and starts plate N,
  // then waits up to 60 s for the printer to start.
  async printFile(data, args) {
    if (BUSY.includes(this.state())) throw new Error('The printer is busy');
    try {
      await ftps.upload({ host: this.cfg.host, port: this.cfg.ftpsPort || 990, user: 'bblp', password: String(this.cfg.accessCode || ''), remoteName: REMOTE_NAME, data });
    } catch (err) {
      throw new Error(`Could not copy the file to the printer: ${err.message}`);
    }
    if (BUSY.includes(this.state())) throw new Error('The printer started something else during the upload');
    // The outside spool is -1 in Bambu's list when the AMS is not used.
    const mapping = (args.amsMapping || []).map((v) => (v === 254 && !args.useAms ? -1 : v));
    try {
      return await this._request('print', {
        param: `Metadata/plate_${args.plate || 1}.gcode`, url: `file:///sdcard/${REMOTE_NAME}`, md5: '',
        project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0', subtask_name: String(args.subtaskName || 'Slothbench print'),
        bed_type: 'auto', use_ams: !!args.useAms, ams_mapping: mapping,
        bed_leveling: args.bedLeveling !== false, timelapse: !!args.timelapse,
        flow_cali: false, vibration_cali: false, layer_inspect: false,
      }, { command: 'project_file', done: () => BUSY.includes(this.state()), timeoutMs: this.cfg.startWaitMs || 60000 });
    } catch (err) {
      if (err.refused) this.dropCapability('print_file');
      if (/did not answer/.test(err.message)) throw new Error('The printer did not start within 60 seconds');
      throw err;
    }
  }

  snapshot() {
    const online = !!(this.client && this.client.connected) && Date.now() - this.lastReportAt < 120000;
    const base = { key: this.key, name: this.cfg.name || this.cfg.serial, type: 'bambu', model: this.cfg.model || '', online, lastError: online ? '' : (this.lastError || 'no data yet'), capabilities: this.capabilities(), dualNozzle: this.dualNozzle };
    return online ? { ...base, ...snapshotFromReport(this.print) } : { ...base, state: 'offline' };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    if (this.client) this.client.end();
  }
}

module.exports = { BambuPrinter, snapshotFromReport, merge, isDualNozzle, FILAMENT_PROFILES, REMOTE_NAME };
