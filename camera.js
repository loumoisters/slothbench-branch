// camera.js
// One still picture from a printer's camera, for the printer card in the
// app. Reading the camera changes nothing on the printer, so it needs no
// control switch - only `"camera": false` in a printer's bridge config
// turns it off.
//
//   bambuFrame({ host, port, accessCode })   A1 and P1 printers: their camera
//       stream on port 6000 (TLS). The bridge logs in with an 80-byte packet
//       (two little-endian numbers, 8 zero bytes, "bblp" and the access code
//       each padded to 32 bytes); the printer then sends frames, each a
//       16-byte header whose first 4 bytes (little-endian) are the size,
//       followed by that many bytes of JPEG. The first JPEG is kept.
//       X1, H2 and P2S printers stream over RTSP instead, which the bridge
//       does not read; after 3 failures it waits 10 minutes (slothbench-branch.js).
//   httpSnapshot(url, headers)   a Klipper webcam's snapshot address.

const tls = require('tls');
const http = require('http');
const https = require('https');

const MAX_BYTES = 2 * 1024 * 1024;

function isJpeg(buf) { return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8; }

function authPacket(accessCode) {
  const b = Buffer.alloc(80);
  b.writeUInt32LE(0x40, 0);
  b.writeUInt32LE(0x3000, 4);
  // bytes 8-15 stay zero
  b.write('bblp', 16, 32, 'ascii');
  b.write(String(accessCode || '').slice(0, 32), 48, 32, 'ascii');
  return b;
}

function bambuFrame({ host, port = 6000, accessCode, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let done = false;
    const sock = tls.connect({ host, port, rejectUnauthorized: false });
    const finish = (err, frame) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(frame);
    };
    const timer = setTimeout(() => finish(new Error('No camera picture within 12 seconds (X1, H2 and P2S cameras are not supported)')), timeoutMs);
    sock.on('secureConnect', () => sock.write(authPacket(accessCode)));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 16) {
        const size = buf.readUInt32LE(0);
        if (size <= 0 || size > MAX_BYTES) return finish(new Error('The camera sent a picture Branch cannot read'));
        if (buf.length < 16 + size) return;
        const frame = buf.subarray(16, 16 + size);
        buf = buf.subarray(16 + size);
        if (isJpeg(frame)) return finish(null, Buffer.from(frame));
      }
    });
    sock.on('error', (err) => finish(new Error(`Camera: ${err.code === 'ECONNREFUSED' ? 'nothing is listening on port ' + port : err.message}`)));
    sock.on('close', () => finish(new Error('The camera closed the connection (check the access code)')));
  });
}

function httpSnapshot(url, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('The webcam address is not a valid URL')); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers, timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`The webcam answered ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('The webcam picture is over 2 MB')); return; } chunks.push(c); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!isJpeg(buf)) return reject(new Error('The webcam did not send a JPEG picture'));
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('No webcam picture within 10 seconds')));
    req.on('error', reject);
  });
}

module.exports = { bambuFrame, httpSnapshot, authPacket, isJpeg, MAX_BYTES };
