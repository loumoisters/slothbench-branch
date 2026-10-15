// mqtt.js
// The smallest MQTT 3.1.1 client the bridge needs to read a Bambu Lab
// printer: connect with a username and password, subscribe to one topic,
// publish a request, keep the connection alive, and hand every incoming
// message to a callback. QoS 0 only (what the printer uses), no retained
// messages, no will. Dependency-free like the rest of Slothbench.
//
// Bambu printers speak MQTT over TLS on port 8883 with a certificate of
// their own (signed by Bambu, not a public CA), so the default is TLS
// without certificate checks - the connection is still encrypted, and it
// only ever goes to the address in your bridge config on your own network.
// `transport: 'tcp'` exists for the test suite's fake printer.

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

// Network errors in words a shop owner can act on.
function friendlyNetError(err, host, port) {
  const where = `${host}:${port}`;
  switch (err && err.code) {
    case 'ECONNREFUSED': return `Nothing is listening at ${where} (wrong port, or the printer's network service is off)`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `Cannot reach ${host} from this computer (is it on the same network?)`;
    case 'ETIMEDOUT': return `No answer from ${where} (wrong address, or the printer is off)`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `${host} is not a known address`;
    case 'ECONNRESET': return `${where} closed the connection`;
    default: return (err && err.message) || 'Connection failed';
  }
}

function encodeLength(n) {
  const bytes = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

function str(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function packet(type, flags, body) {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}

class MqttClient extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = { port: 8883, transport: 'tls', keepalive: 30, ...opts };
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.connected = false;
  }

  connect() {
    const o = this.opts;
    return new Promise((resolve, reject) => {
      const onError = (err) => { cleanup(); reject(err); };
      const onConnack = (code) => {
        cleanup();
        if (code === 0) { this.connected = true; resolve(); return; }
        const reasons = { 1: 'protocol version refused', 2: 'client id refused', 3: 'server unavailable', 4: 'bad username or password (check the access code)', 5: 'not authorised (check the access code)' };
        reject(new Error(`MQTT connect refused: ${reasons[code] || `code ${code}`}`));
      };
      const timer = setTimeout(() => onError(new Error(`No answer from ${o.host}:${o.port} within 10 seconds`)), 10000);
      const cleanup = () => { clearTimeout(timer); this.off('_connack', onConnack); this.off('_error', onError); };
      this.on('_connack', onConnack);
      this.on('_error', onError);

      const socket = o.transport === 'tcp'
        ? net.connect({ host: o.host, port: o.port })
        : tls.connect({ host: o.host, port: o.port, rejectUnauthorized: false });
      this.socket = socket;
      socket.on(o.transport === 'tcp' ? 'connect' : 'secureConnect', () => {
        const flags = 0x02 | (o.username != null ? 0x80 : 0) | (o.password != null ? 0x40 : 0); // clean session
        const keep = Buffer.alloc(2);
        keep.writeUInt16BE(o.keepalive);
        const body = Buffer.concat([
          str('MQTT'), Buffer.from([4, flags]), keep,
          str(o.clientId || `jpi-bridge-${Math.random().toString(16).slice(2, 10)}`),
          ...(o.username != null ? [str(o.username)] : []),
          ...(o.password != null ? [str(o.password)] : []),
        ]);
        socket.write(packet(1, 0, body));
      });
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (raw) => { const err = new Error(friendlyNetError(raw, o.host, o.port)); err.code = raw.code; this.emit('_error', err); this.emit('error', err); });
      socket.on('close', () => {
        const was = this.connected;
        this.connected = false;
        clearInterval(this.pinger);
        if (was) this.emit('close');
      });
      this.pinger = setInterval(() => { if (this.connected) socket.write(Buffer.from([0xc0, 0x00])); }, o.keepalive * 1000 * 0.8);
      if (this.pinger.unref) this.pinger.unref();
    });
  }

  subscribe(topic) {
    const id = Buffer.alloc(2);
    id.writeUInt16BE(this.nextId++ & 0xffff || 1);
    this.socket.write(packet(8, 2, Buffer.concat([id, str(topic), Buffer.from([0])])));
  }

  publish(topic, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    this.socket.write(packet(3, 0, Buffer.concat([str(topic), data])));
  }

  end() {
    clearInterval(this.pinger);
    if (!this.socket) return;
    try { if (this.connected) this.socket.write(Buffer.from([0xe0, 0x00])); } catch (e) { /* already gone */ }
    this.socket.destroy();
    this.connected = false;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      let mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= this.buffer.length) return; // length not complete yet
        byte = this.buffer[i++];
        len += (byte & 0x7f) * mult;
        mult *= 128;
        if (i > 5) { this.emit('_error', new Error('Malformed MQTT packet')); this.end(); return; }
      } while (byte & 0x80);
      if (this.buffer.length < i + len) return;
      const header = this.buffer[0];
      const body = this.buffer.subarray(i, i + len);
      this.buffer = this.buffer.subarray(i + len);
      const type = header >> 4;
      if (type === 2) this.emit('_connack', body[1]);
      else if (type === 3) {
        const qos = (header >> 1) & 3;
        const tlen = body.readUInt16BE(0);
        const topic = body.subarray(2, 2 + tlen).toString('utf8');
        const payload = body.subarray(2 + tlen + (qos ? 2 : 0));
        this.emit('message', topic, payload);
      }
      // SUBACK (9) and PINGRESP (13) need no handling.
    }
  }
}

module.exports = { MqttClient, packet, str, encodeLength, friendlyNetError };
