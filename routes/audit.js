'use strict';
const express = require('express');
const db = require('../db');
const A = require('../lib/auth');

const router = express.Router();
router.use(A.requireAuth(), A.requireRole('admin'));

router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const q = String(req.query.q || '').trim().slice(0, 60);
  const where = q ? 'WHERE username LIKE @like OR action LIKE @like OR detail LIKE @like' : '';
  const params = q ? { like: `%${q.replace(/[\\%_]/g, m => '\\' + m)}%` } : {};
  const esc = q ? " ESCAPE '\\'" : '';
  const whereSql = where ? where.replace(/LIKE @like/g, `LIKE @like${esc}`) : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM audit_log ${whereSql}`).get(params).c;
  const rows = db.prepare(`SELECT id, username, action, entity, entity_id, detail, ip, created_at FROM audit_log ${whereSql}
    ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}`).all(params);
  res.json({ total, rows });
});

module.exports = router;
