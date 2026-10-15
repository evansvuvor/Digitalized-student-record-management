'use strict';
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('./helpers');

const getUser = db.prepare(
  'SELECT id, username, full_name, role, is_active, must_change_password FROM users WHERE id = ?'
);

// Loads the signed-in user fresh from the database on every request, so
// deactivating an account or changing a role takes effect immediately.
function loadUser(req) {
  const sid = req.session && req.session.userId;
  if (!sid) return null;
  const u = getUser.get(sid);
  if (!u || !u.is_active) return null;
  return u;
}

function requireAuth(opts = {}) {
  return (req, res, next) => {
    const u = loadUser(req);
    if (!u) {
      if (req.session && req.session.userId) req.session.destroy(() => {});
      return next(new HttpError(401, 'Please sign in.'));
    }
    req.user = u;
    if (u.must_change_password && !opts.allowMustChange) {
      const err = new HttpError(403, 'You must change your temporary password before continuing.');
      err.code = 'MUST_CHANGE_PASSWORD';
      return next(err);
    }
    next();
  };
}

const ROLE_RANK = { viewer: 1, registrar: 2, admin: 3 };
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user || ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return next(new HttpError(403, 'Your account does not have permission to do that.'));
    }
    next();
  };
}

// Light CSRF defence: state-changing requests must carry a custom header that
// cross-site forms cannot set. Combined with SameSite cookies.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'spaco-vault') return next(new HttpError(403, 'Request blocked.'));
  next();
}

function hashPassword(pw) { return bcrypt.hashSync(pw, 12); }
function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }

function validatePassword(pw, username) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 100) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain both letters and numbers.';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the username.';
  return null;
}

function randomPassword() {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  let out = '';
  for (let i = 0; i < 12; i++) out += all[crypto.randomInt(all.length)];
  // guarantee at least one digit and one letter
  return out.slice(0, 10) + letters[crypto.randomInt(letters.length)] + digits[crypto.randomInt(digits.length)];
}

// A pre-computed hash used to keep login timing similar for unknown usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

module.exports = { requireAuth, requireRole, csrfGuard, hashPassword, verifyPassword, validatePassword, randomPassword, DUMMY_HASH };
