'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');
const A = require('../lib/auth');
const { slugify, absFilePath, audit, wrap, HttpError, str } = require('../lib/helpers');

const router = express.Router();
router.use(A.requireAuth());

const canWrite = A.requireRole('registrar');
const STATUSES = ['current', 'alumni', 'transferred'];

const pid = v => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id.');
  return n;
};

// ---------- dashboard ----------
router.get('/stats', (req, res) => {
  const one = sql => db.prepare(sql).get();
  res.json({
    batches: one('SELECT COUNT(*) c FROM batches').c,
    classes: one('SELECT COUNT(*) c FROM classes').c,
    students: one('SELECT COUNT(*) c FROM students').c,
    current: one("SELECT COUNT(*) c FROM students WHERE status='current'").c,
    alumni: one("SELECT COUNT(*) c FROM students WHERE status='alumni'").c,
    documents: one('SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL').c,
    bytes: one('SELECT COALESCE(SUM(size_bytes),0) c FROM documents WHERE deleted_at IS NULL').c
  });
});

// ---------- batches ----------
router.get('/batches', (req, res) => {
  const batches = db.prepare(`
    SELECT b.id, b.label,
      (SELECT COUNT(*) FROM classes c WHERE c.batch_id = b.id) AS class_count,
      (SELECT COUNT(*) FROM students s JOIN classes c ON c.id = s.class_id WHERE c.batch_id = b.id) AS student_count
    FROM batches b ORDER BY b.label DESC`).all();
  res.json({ batches });
});

router.post('/batches', canWrite, wrap(async (req, res) => {
  const label = str(req.body.label, 20).replace(/[–—]/g, '-');
  if (!/^\d{4}(-\d{4})?$/.test(label)) throw new HttpError(400, 'Batch must be a year such as 2023, or a range such as 2020-2023.');
  if (db.prepare('SELECT 1 FROM batches WHERE label = ?').get(label)) throw new HttpError(409, `Batch ${label} already exists.`);
  const info = db.prepare('INSERT INTO batches (label) VALUES (?)').run(label);
  audit(req, 'batch.create', 'batch', info.lastInsertRowid, label);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.get('/batches/:id', (req, res) => {
  const id = pid(req.params.id);
  const batch = db.prepare('SELECT id, label FROM batches WHERE id = ?').get(id);
  if (!batch) throw new HttpError(404, 'Batch not found.');
  const classes = db.prepare(`
    SELECT c.id, c.name,
      (SELECT COUNT(*) FROM students s WHERE s.class_id = c.id) AS student_count,
      (SELECT COUNT(*) FROM documents d JOIN students s ON s.id = d.student_id WHERE s.class_id = c.id AND d.deleted_at IS NULL) AS document_count
    FROM classes c WHERE c.batch_id = ? ORDER BY c.name COLLATE NOCASE`).all(id);
  res.json({ batch, classes });
});

router.delete('/batches/:id', canWrite, wrap(async (req, res) => {
  const id = pid(req.params.id);
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(id);
  if (!batch) throw new HttpError(404, 'Batch not found.');
  if (db.prepare('SELECT 1 FROM classes WHERE batch_id = ?').get(id)) throw new HttpError(409, 'Only empty batches can be removed. Remove its classes first.');
  db.prepare('DELETE FROM batches WHERE id = ?').run(id);
  audit(req, 'batch.delete', 'batch', id, batch.label);
  res.json({ ok: true });
}));

// ---------- classes ----------
router.post('/batches/:id/classes', canWrite, wrap(async (req, res) => {
  const batchId = pid(req.params.id);
  const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(batchId);
  if (!batch) throw new HttpError(404, 'Batch not found.');
  const name = str(req.body.name, 60);
  if (!name) throw new HttpError(400, 'Class name is required.');
  const slug = slugify(name);
  const clash = db.prepare('SELECT 1 FROM classes WHERE batch_id = ? AND (name = ? COLLATE NOCASE OR slug = ?)').get(batchId, name, slug);
  if (clash) throw new HttpError(409, `A class named "${name}" already exists in batch ${batch.label}.`);
  const info = db.prepare('INSERT INTO classes (batch_id, name, slug) VALUES (?,?,?)').run(batchId, name, slug);
  audit(req, 'class.create', 'class', info.lastInsertRowid, `${batch.label} / ${name}`);
  res.status(201).json({ id: info.lastInsertRowid });
}));

router.get('/classes/:id', (req, res) => {
  const id = pid(req.params.id);
  const cls = db.prepare(`SELECT c.id, c.name, c.batch_id, b.label AS batch_label
    FROM classes c JOIN batches b ON b.id = c.batch_id WHERE c.id = ?`).get(id);
  if (!cls) throw new HttpError(404, 'Class not found.');
  const students = db.prepare(`
    SELECT s.id, s.record_id, s.full_name, s.gender, s.status, s.guardian_name, s.guardian_phone,
      (SELECT COUNT(*) FROM documents d WHERE d.student_id = s.id AND d.deleted_at IS NULL) AS document_count
    FROM students s WHERE s.class_id = ? ORDER BY s.full_name COLLATE NOCASE`).all(id);
  res.json({ class: cls, students });
});

router.delete('/classes/:id', canWrite, wrap(async (req, res) => {
  const id = pid(req.params.id);
  const cls = db.prepare('SELECT c.*, b.label FROM classes c JOIN batches b ON b.id=c.batch_id WHERE c.id = ?').get(id);
  if (!cls) throw new HttpError(404, 'Class not found.');
  if (db.prepare('SELECT 1 FROM students WHERE class_id = ?').get(id)) throw new HttpError(409, 'Only empty classes can be removed. Move or remove its students first.');
  db.prepare('DELETE FROM classes WHERE id = ?').run(id);
  audit(req, 'class.delete', 'class', id, `${cls.label} / ${cls.name}`);
  res.json({ ok: true, batch_id: cls.batch_id });
}));

// ---------- students ----------
function nextRecordId(batchLabel) {
  const prefix = `${config.RECORD_PREFIX}-${batchLabel}-`;
  const last = db.prepare("SELECT record_id FROM students WHERE record_id LIKE ? ORDER BY record_id DESC LIMIT 1").get(prefix + '%');
  const n = last ? parseInt(last.record_id.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

function readStudentBody(body) {
  const gender = str(body.gender, 10);
  const dob = str(body.date_of_birth, 10);
  const status = str(body.status || 'current', 20);
  if (gender && !['Male', 'Female'].includes(gender)) throw new HttpError(400, 'Gender must be Male or Female.');
  if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new HttpError(400, 'Date of birth must be a valid date.');
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Choose a valid status.');
  return {
    full_name: str(body.full_name, 150), gender: gender || null, date_of_birth: dob || null,
    guardian_name: str(body.guardian_name, 150) || null, guardian_phone: str(body.guardian_phone, 40) || null, status
  };
}

const createStudentTx = db.transaction((classId, batchLabel, d) => {
  const record_id = nextRecordId(batchLabel);
  const info = db.prepare(`INSERT INTO students (record_id, full_name, gender, date_of_birth, guardian_name, guardian_phone, status, class_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(record_id, d.full_name, d.gender, d.date_of_birth, d.guardian_name, d.guardian_phone, d.status, classId);
  return { id: info.lastInsertRowid, record_id };
});

router.post('/classes/:id/students', canWrite, wrap(async (req, res) => {
  const classId = pid(req.params.id);
  const cls = db.prepare('SELECT c.*, b.label AS batch_label FROM classes c JOIN batches b ON b.id=c.batch_id WHERE c.id = ?').get(classId);
  if (!cls) throw new HttpError(404, 'Class not found.');
  const d = readStudentBody(req.body);
  if (!d.full_name) throw new HttpError(400, "Student's full name is required.");
  const created = createStudentTx(classId, cls.batch_label, d);
  audit(req, 'student.create', 'student', created.id, `${created.record_id} ${d.full_name}`);
  res.status(201).json(created);
}));

router.post('/classes/:id/students/bulk', canWrite, wrap(async (req, res) => {
  const classId = pid(req.params.id);
  const cls = db.prepare('SELECT c.*, b.label AS batch_label FROM classes c JOIN batches b ON b.id=c.batch_id WHERE c.id = ?').get(classId);
  if (!cls) throw new HttpError(404, 'Class not found.');
  const status = str(req.body.status || 'current', 20);
  if (!STATUSES.includes(status)) throw new HttpError(400, 'Choose a valid status.');
  const names = (Array.isArray(req.body.names) ? req.body.names : [])
    .map(n => str(n, 150)).filter(Boolean);
  if (!names.length) throw new HttpError(400, 'Enter at least one name.');
  if (names.length > 500) throw new HttpError(400, 'Please add at most 500 students at a time.');
  const run = db.transaction(() => names.map(n => createStudentTx(classId, cls.batch_label, {
    full_name: n, gender: null, date_of_birth: null, guardian_name: null, guardian_phone: null, status })));
  const created = run();
  audit(req, 'student.bulk_create', 'class', classId, `${created.length} students into ${cls.batch_label} / ${cls.name}`);
  res.status(201).json({ created: created.length });
}));

router.get('/students/:id', (req, res) => {
  const id = pid(req.params.id);
  const s = db.prepare(`SELECT s.*, c.name AS class_name, c.id AS class_id, c.batch_id, b.label AS batch_label
    FROM students s JOIN classes c ON c.id = s.class_id JOIN batches b ON b.id = c.batch_id WHERE s.id = ?`).get(id);
  if (!s) throw new HttpError(404, 'Student not found.');
  res.json({ student: s });
});

router.patch('/students/:id', canWrite, wrap(async (req, res) => {
  const id = pid(req.params.id);
  const cur = db.prepare(`SELECT s.*, c.slug AS class_slug, b.label AS batch_label FROM students s
    JOIN classes c ON c.id = s.class_id JOIN batches b ON b.id = c.batch_id WHERE s.id = ?`).get(id);
  if (!cur) throw new HttpError(404, 'Student not found.');
  const d = readStudentBody({ ...cur, ...req.body });
  if (!d.full_name) throw new HttpError(400, "Student's full name is required.");

  let newClassId = cur.class_id;
  if (req.body.class_id !== undefined && parseInt(req.body.class_id, 10) !== cur.class_id) {
    newClassId = pid(req.body.class_id);
    const dest = db.prepare('SELECT c.*, b.label AS batch_label FROM classes c JOIN batches b ON b.id=c.batch_id WHERE c.id = ?').get(newClassId);
    if (!dest) throw new HttpError(404, 'Destination class not found.');
    // Move the student's document folder so disk layout always matches the database.
    const oldRel = path.join(cur.batch_label, cur.class_slug, cur.record_id);
    const newRel = path.join(dest.batch_label, dest.slug, cur.record_id);
    const oldAbs = absFilePath(oldRel), newAbs = absFilePath(newRel);
    if (fs.existsSync(oldAbs)) {
      if (fs.existsSync(newAbs)) throw new HttpError(409, 'A folder for this student already exists in the destination class.');
      fs.mkdirSync(path.dirname(newAbs), { recursive: true });
      fs.renameSync(oldAbs, newAbs);
    }
    const docs = db.prepare('SELECT id, stored_name FROM documents WHERE student_id = ?').all(id);
    const upd = db.prepare('UPDATE documents SET storage_path = ? WHERE id = ?');
    try {
      db.transaction(() => {
        docs.forEach(doc => upd.run(path.posix.join(dest.batch_label, dest.slug, cur.record_id, doc.stored_name), doc.id));
        db.prepare('UPDATE students SET class_id = ? WHERE id = ?').run(newClassId, id);
      })();
    } catch (e) {
      if (fs.existsSync(newAbs) && !fs.existsSync(oldAbs)) fs.renameSync(newAbs, oldAbs); // roll the folder back
      throw e;
    }
    audit(req, 'student.move', 'student', id, `${cur.record_id} → ${dest.batch_label} / ${dest.name}`);
  }

  db.prepare(`UPDATE students SET full_name=?, gender=?, date_of_birth=?, guardian_name=?, guardian_phone=?, status=?,
    updated_at=datetime('now') WHERE id=?`).run(d.full_name, d.gender, d.date_of_birth, d.guardian_name, d.guardian_phone, d.status, id);
  audit(req, 'student.update', 'student', id, `${cur.record_id} ${d.full_name}`);
  res.json({ ok: true });
}));

// ---------- search ----------
router.get('/search', (req, res) => {
  const q = str(req.query.q, 80);
  if (q.length < 2) return res.json({ results: [] });
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const results = db.prepare(`
    SELECT s.id, s.record_id, s.full_name, s.status, c.name AS class_name, b.label AS batch_label
    FROM students s JOIN classes c ON c.id = s.class_id JOIN batches b ON b.id = c.batch_id
    WHERE s.full_name LIKE ? ESCAPE '\\' OR s.record_id LIKE ? ESCAPE '\\'
    ORDER BY b.label DESC, s.full_name COLLATE NOCASE LIMIT 30`).all(like, like);
  res.json({ results });
});

module.exports = router;
