#!/usr/bin/env node
// scripts/scan-secrets.js
// Looks for secrets in the code: API keys, tokens, private keys, webhook
// addresses with their token, passwords written into code, and files that
// should never be committed (.env, private keys, databases). Real secrets
// stay in your branch.config.json, which is never committed.
//
//   node scripts/scan-secrets.js            every tracked file (CI, release)
//   node scripts/scan-secrets.js --staged   what is about to be committed
//                                           (.githooks/pre-commit)
//   node scripts/scan-secrets.js --history  every line ever added, in every
//                                           commit (a deleted secret is still
//                                           in the history)
//
// Exits 1 and lists file:line (never the value) when it finds something.
// A line that is a deliberate fake (a test fixture, an example) can carry
// the comment "secret-scan: allow".
//
// Zero dependencies, like the rest of Branch; the same file is in the
// Slothbench app's repo.

const { execFileSync } = require('child_process');
const path = require('path');

const PATTERNS = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Stripe secret key', /\b[sr]k_(live|test)_[0-9a-zA-Z]{16,}/],
  ['Stripe webhook secret', /\bwhsec_[0-9a-zA-Z]{20,}/],
  ['GitHub token', /\b(ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{30,}|\bgithub_pat_[0-9A-Za-z_]{30,}/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}/],
  ['Anthropic key', /\bsk-ant-[0-9A-Za-z_-]{20,}/],
  ['OpenAI key', /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/],
  ['Telegram bot token', /\b[0-9]{8,10}:AA[0-9A-Za-z_-]{33}\b/],
  ['Backblaze key', /\bK00[0-9A-Za-z]{28,}/],
  ['Resend key', /\bre_[0-9A-Za-z]{8,}_[0-9A-Za-z]{16,}/],
  ['SendGrid key', /\bSG\.[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
  ['Discord webhook', /discord(app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{20,}/],
  ['Slack webhook', /hooks\.slack\.com\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+/],
  ['Password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"`]+:[^/\s@'"`$]{6,}@[^/\s'"`]/],
  ['Secret written into code', /\b(password|passwd|secret|api_?key|apikey|auth_?token|access_?token|client_?secret|access_?code)['"]?\s*[:=]\s*['"][A-Za-z0-9+/_.\-]{16,}['"]/i],
];

// Files that should never be in the repo at all, whatever they contain.
const FORBIDDEN_FILES = [
  [/(^|\/)\.env(\.[^/]*)?$/, (f) => !/\.env\.example$/.test(f), 'an .env file'],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, () => true, 'a key or certificate file'],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, () => true, 'an SSH private key'],
  [/\.(sqlite|sqlite3|db)(-wal|-shm)?$/i, () => true, 'a database'],
  [/(^|\/)(branch|bridge)\.config\.json$/, () => true, "Branch's settings file (printer access codes)"],
];

const ALLOW = /secret-scan:\s*allow/;
const SKIP = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|mp4|mp3|wav|3mf|stl|gcode)$/i;

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 1024 * 1024 * 512, ...opts });
}

// Tests sign up with made-up passwords ('test-password-123') on purpose,
// so in test/ only the real key formats count, not "password: '...'".
const TEST_FILE = /(^|[\s/])test\//;

function checkLine(file, lineNo, line, found) {
  if (ALLOW.test(line)) return;
  for (const [name, re] of PATTERNS) {
    if (name === 'Secret written into code' && TEST_FILE.test(file)) continue;
    if (re.test(line)) found.push(`${file}:${lineNo}  ${name}`);
  }
}

function checkFileName(file, found) {
  for (const [re, applies, what] of FORBIDDEN_FILES) {
    if (re.test(file) && applies(file)) found.push(`${file}  is ${what} and should not be committed`);
  }
}

function scanTracked(found) {
  const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
  for (const f of files) {
    checkFileName(f, found);
    if (SKIP.test(f)) continue;
    let text;
    try { text = require('fs').readFileSync(path.join(__dirname, '..', f), 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => checkLine(f, i + 1, line, found));
  }
  return files.length;
}

// Added lines of a diff: "+++ b/<file>" names the file, "@@ -a,b +c,d @@"
// the first line number, "+" lines are what was added.
function scanDiff(diff, found, label) {
  let file = '';
  let lineNo = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('commit ')) { label.commit = line.slice(7, 15); continue; }
    if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); if (file !== '/dev/null') checkFileName(file, found); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) { lineNo = Number(hunk[1]); continue; }
    if (!file || SKIP.test(file)) continue;
    if (line.startsWith('+')) { checkLine(label.commit ? `${label.commit} ${file}` : file, lineNo, line.slice(1), found); lineNo += 1; }
    else if (!line.startsWith('-')) lineNo += 1;
  }
}

function main() {
  const mode = process.argv[2] || '';
  const found = [];
  let what;
  if (mode === '--staged') {
    scanDiff(git(['diff', '--cached', '--no-color', '-U0', '--diff-filter=ACMR']), found, {});
    what = 'the staged changes';
  } else if (mode === '--history') {
    scanDiff(git(['log', '--all', '-p', '--no-color', '-U0', '--format=commit %H']), found, { commit: '' });
    what = 'every commit';
  } else {
    what = `${scanTracked(found)} tracked files`;
  }
  const unique = [...new Set(found)];
  if (!unique.length) { console.log(`Secret scan: nothing found in ${what}.`); return; }
  console.error(`Secret scan: ${unique.length} possible secret${unique.length === 1 ? '' : 's'} in ${what}:`);
  for (const f of unique) console.error(`  ${f}`);
  console.error('\nMove real secrets to branch.config.json (never committed) and rotate any that were committed:');
  console.error('deleting them from the code does not remove them from the git history. A deliberate fake can');
  console.error('carry the comment "secret-scan: allow" on its line.');
  process.exit(1);
}

if (require.main === module) main();
module.exports = { PATTERNS, FORBIDDEN_FILES, checkLine, checkFileName, scanDiff };
