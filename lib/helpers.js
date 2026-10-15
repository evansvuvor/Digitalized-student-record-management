'use strict';
const path = require('path');
const config = require('../config');
const db = require('../db');

function slugify(s) {
  const out = String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return out || 'x';
}

// Turn a client-supplied filename into something safe to keep on disk.
function safeFileName(original) {
  const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, '');
  const base = path.basename(original, path.extname(original)).normalize('NFKD')
    .replace(/[^A-Za-z0-9._ -]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'scan';
  return { base, ext };
}

// Resolve a relative storage path and make sure it cannot escape FILES_DIR.
function absFilePath(rel) {
  const abs = path.resolve(config.FILES_DIR, rel);
  if (abs !== config.FILES_DIR && !abs.startsWith(config.FILES_DIR + path.sep)) {
    throw new Error('Unsafe path');
  }
  return abs;
}

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || '';
}

const insertAudit = db.prepare(
  'INSERT INTO audit_log (user_id, username, action, entity, entity_id, detail, ip) VALUES (?,?,?,?,?,?,?)'
);
function audit(req, action, entity, entityId, detail, userOverride) {
  const u = userOverride || req.user || null;
  try {
    insertAudit.run(u ? u.id : null, u ? u.username : null, action, entity || null,
      entityId == null ? null : entityId, detail || null, clientIp(req));
  } catch (e) { console.error('audit failed:', e.message); }
}

// Wrap async route handlers so thrown errors reach the error middleware.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function str(v, max = 200) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

module.exports = { slugify, safeFileName, absFilePath, audit, wrap, HttpError, str, clientIp };
