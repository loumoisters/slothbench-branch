// ftps.js
// The smallest FTP-over-TLS client the bridge needs to put one file on a
// Bambu Lab printer's SD card before printing it: implicit TLS on port 990
// (TLS from the first byte), log in as bblp with the LAN access code, then
// PBSZ / PROT P / TYPE I / PASV / STOR. The data connection is TLS too and
// reuses the control connection's TLS session, which the printer's FTP
// server insists on. TLS 1.2 only: some printers cut uploads short on 1.3.
//
// Like the MQTT connection, certificates are not checked - the printer's
// certificate is its own, not a public one - and the connection only ever
// goes to the address in the bridge config.
//
//   await upload({ host, port, user, password, remoteName, data, timeoutMs })

const tls = require('tls');

const TLS_OPTS = { rejectUnauthorized: false, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };

// Reads FTP replies ("230 Logged in", or several "230-..." lines ending
// with "230 ...") one at a time.
function replyReader(socket) {
  let buf = '';
  let lines = [];
  const ready = [];
  const waiting = [];
  let failed = null;
  const deliver = () => {
    while (ready.length && waiting.length) waiting.shift().resolve(ready.shift());
    if (failed) while (waiting.length) waiting.shift().reject(failed);
  };
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      const m = /^(\d{3})([ -])/.exec(line);
      const first = /^(\d{3})-/.exec(lines[0] || '');
      if (m && m[2] === ' ' && (!first || first[1] === m[1])) {
        ready.push({ code: Number(m[1]), text: lines.join('\n') });
        lines = [];
      }
    }
    deliver();
  });
  const fail = (err) => { if (!failed) { failed = err; deliver(); } };
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('The printer closed the file connection')));
  return function next(timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(new Error('The printer stopped answering during the upload')); }, timeoutMs);
      const entry = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      waiting.push(entry);
      deliver();
    });
  };
}

async function upload({ host, port = 990, user = 'bblp', password, remoteName, data, timeoutMs = 120000 }) {
  if (!Buffer.isBuffer(data)) throw new Error('Nothing to upload');
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(remoteName || ''))) throw new Error('Bad remote file name');
  const control = tls.connect({ host, port, ...TLS_OPTS });
  const next = replyReader(control);
  let dataSock = null;
  const expect = async (codes, what, ms) => {
    const r = await next(ms);
    if (!codes.includes(r.code)) throw new Error(`${what}: the printer answered "${r.text.split('\n').pop().slice(0, 120)}"`);
    return r;
  };
  const cmd = (line) => control.write(line + '\r\n');
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`No answer from ${host}:${port} (file upload) within 10 seconds`)), 10000);
      control.once('secureConnect', () => { clearTimeout(t); resolve(); });
      control.once('error', (err) => { clearTimeout(t); reject(new Error(`Cannot open the file connection to ${host}:${port}: ${err.message}`)); });
    });
    await expect([220], 'Connecting');
    cmd(`USER ${user}`);
    const u = await expect([230, 331], 'Logging in');
    if (u.code === 331) { cmd(`PASS ${password}`); await expect([230], 'Logging in (check the access code)'); }
    cmd('PBSZ 0'); await expect([200], 'Setting up');
    cmd('PROT P'); await expect([200], 'Setting up encryption');
    cmd('TYPE I'); await expect([200], 'Setting binary mode');
    cmd('PASV');
    const pasv = await expect([227], 'Opening the data connection');
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text);
    if (!m) throw new Error('The printer sent an address Branch cannot read');
    const dataPort = Number(m[5]) * 256 + Number(m[6]);
    // Only the port is used: the data connection goes to the same printer.
    dataSock = tls.connect({ host, port: dataPort, ...TLS_OPTS, session: control.getSession() });
    const dataReady = new Promise((resolve, reject) => {
      dataSock.once('secureConnect', resolve);
      dataSock.once('error', (err) => reject(new Error(`The data connection failed: ${err.message}`)));
    });
    cmd(`STOR ${remoteName}`);
    await expect([125, 150], 'Starting the upload');
    await dataReady;
    await new Promise((resolve, reject) => {
      dataSock.once('error', reject);
      dataSock.end(data, resolve);
    });
    await expect([226, 250], 'Finishing the upload', timeoutMs);
    cmd('QUIT');
    return { bytes: data.length };
  } finally {
    if (dataSock) dataSock.destroy();
    control.destroy();
  }
}

module.exports = { upload, replyReader };
