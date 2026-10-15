'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Minimal .env loader (KEY=value per line) so no extra dependency is needed.
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

// Session secret: from .env, or generated once and kept in the data folder.
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, '.session_secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  HOST: process.env.HOST || '0.0.0.0',
  DATA_DIR,
  FILES_DIR: path.join(DATA_DIR, 'files'),
  TMP_DIR: path.join(DATA_DIR, 'tmp'),
  DB_PATH: path.join(DATA_DIR, 'vault.db'),
  BACKUP_DIR: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(__dirname, 'backups'),
  SESSION_SECRET: getSessionSecret(),
  // Set COOKIE_SECURE=true once the site is served over HTTPS.
  COOKIE_SECURE: String(process.env.COOKIE_SECURE || 'false') === 'true',
  // Set TRUST_PROXY=1 if running behind nginx/Caddy so client IPs are logged correctly.
  TRUST_PROXY: process.env.TRUST_PROXY || '',
  MAX_UPLOAD_MB: parseInt(process.env.MAX_UPLOAD_MB || '25', 10),
  SESSION_HOURS: parseInt(process.env.SESSION_HOURS || '8', 10),
  SCHOOL_NAME: process.env.SCHOOL_NAME || "St. Paul's SHS & Minor Seminary",
  RECORD_PREFIX: process.env.RECORD_PREFIX || 'SPC'
};
