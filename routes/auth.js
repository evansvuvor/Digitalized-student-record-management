'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const A = require('../lib/auth');
const { audit, wrap, HttpError, str } = require('../lib/helpers');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' })
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const username = str(req.body.username, 60);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = row ? A.verifyPassword(password, row.password_hash) : (A.verifyPassword(password, A.DUMMY_HASH), false);
  if (!row || !ok || !row.is_active) {
    audit(req, 'login.failed', 'user', row ? row.id : null, 'username=' + username, { id: row ? row.id : null, username });
    throw new HttpError(401, 'Incorrect username or password.');
  }
  await new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve()));
  req.session.userId = row.id;
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  audit(req, 'login', 'user', row.id, null, row);
  res.json({ user: publicUser(row) });
}));

router.post('/logout', (req, res) => {
  const u = req.session && req.session.userId;
  if (u) audit(req, 'logout', 'user', u, null, { id: u, username: null });
  req.session.destroy(() => { res.clearCookie('spaco.sid'); res.json({ ok: true }); });
});

router.get('/me', A.requireAuth({ allowMustChange: true }), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/password', A.requireAuth({ allowMustChange: true }), wrap(async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : '';
  const next = typeof req.body.next === 'string' ? req.body.next : '';
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!A.verifyPassword(current, row.password_hash)) throw new HttpError(400, 'Your current password is incorrect.');
  const problem = A.validatePassword(next, row.username);
  if (problem) throw new HttpError(400, problem);
  if (A.verifyPassword(next, row.password_hash)) throw new HttpError(400, 'Choose a password different from your current one.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(A.hashPassword(next), row.id);
  audit(req, 'password.change', 'user', row.id);
  res.json({ ok: true });
}));

function publicUser(u) {
  return { id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change_password: !!u.must_change_password };
}

module.exports = router;
