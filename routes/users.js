'use strict';
const express = require('express');
const db = require('../db');
const A = require('../lib/auth');
const { audit, wrap, HttpError, str } = require('../lib/helpers');

const router = express.Router();
router.use(A.requireAuth(), A.requireRole('admin'));

const ROLES = ['admin', 'registrar', 'viewer'];

// End every active session for a user (exact id match, so user 5 never hits user 50).
function endSessionsFor(id) {
  db.prepare('DELETE FROM sessions WHERE sess LIKE ? OR sess LIKE ?')
    .run(`%"userId":${id},%`, `%"userId":${id}}%`);
}

router.get('/', (req, res) => {
  const users = db.prepare(
    'SELECT id, username, full_name, role, is_active, must_change_password, last_login_at, created_at FROM users ORDER BY username'
  ).all();
  res.json({ users });
});

router.post('/', wrap(async (req, res) => {
  const username = str(req.body.username, 40);
  const full_name = str(req.body.full_name, 100);
  const role = str(req.body.role, 20);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) throw new HttpError(400, 'Username must be 3–40 letters, numbers, dot, dash or underscore.');
  if (!full_name) throw new HttpError(400, 'Full name is required.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a valid role.');
  const problem = A.validatePassword(password, username);
  if (problem) throw new HttpError(400, problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is already taken.');
  const info = db.prepare(
    'INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?,?,?,?,1)'
  ).run(username, full_name, A.hashPassword(password), role);
  audit(req, 'user.create', 'user', info.lastInsertRowid, `${username} (${role})`);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.patch('/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'User not found.');
  const full_name = req.body.full_name !== undefined ? str(req.body.full_name, 100) : target.full_name;
  const role = req.body.role !== undefined ? str(req.body.role, 20) : target.role;
  const is_active = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : target.is_active;
  if (!full_name) throw new HttpError(400, 'Full name is required.');
  if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a valid role.');
  if (id === req.user.id && (role !== 'admin' || !is_active)) {
    throw new HttpError(400, 'You cannot remove your own administrator access.');
  }
  if (target.role === 'admin' && (role !== 'admin' || !is_active)) {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND is_active=1 AND id != ?").get(id).c;
    if (admins < 1) throw new HttpError(400, 'There must be at least one active administrator.');
  }
  db.prepare('UPDATE users SET full_name=?, role=?, is_active=? WHERE id=?').run(full_name, role, is_active, id);
  if (!is_active) endSessionsFor(id);
  audit(req, 'user.update', 'user', id, `role=${role} active=${is_active}`);
  res.json({ ok: true });
}));

router.post('/:id/reset-password', wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw new HttpError(404, 'User not found.');
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const problem = A.validatePassword(password, target.username);
  if (problem) throw new HttpError(400, problem);
  db.prepare('UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?').run(A.hashPassword(password), id);
  endSessionsFor(id);
  audit(req, 'user.reset_password', 'user', id, target.username);
  res.json({ ok: true });
}));

module.exports = router;
