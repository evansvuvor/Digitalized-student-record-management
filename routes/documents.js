'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../db');
const config = require('../config');
const A = require('../lib/auth');
const { safeFileName, absFilePath, audit, wrap, HttpError, str } = require('../lib/helpers');

const router = express.Router();
router.use(A.requireAuth());

const canWrite = A.requireRole('registrar');
const isAdmin = A.requireRole('admin');

const CATEGORIES = ['Admission form', 'Birth certificate', 'BECE results slip', 'Transfer letter',
  'Report card', 'Medical record', 'Disciplinary record', 'Passport photo', 'Other'];

// Only these types are accepted, and the real type is checked from the file's first bytes
// (never from the filename or the browser-supplied type).
function sniffType(buf) {
  if (buf.length >= 4 && buf.slice(0, 4).toString('latin1') === '%PDF') return { ext: '.pdf', mime: 'application/pdf' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buf.length >= 12 && buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return { ext: '.webp', mime: 'image/webp' };
  if (buf.length >= 4 && (buf.slice(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || buf.slice(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) return { ext: '.tif', mime: 'image/tiff' };
  return null;
}
const PREVIEWABLE = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.TMP_DIR),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex'))
  }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 20 }
});

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(12); const n = fs.readSync(fd, b, 0, 12, 0); return b.slice(0, n); }
  finally { fs.closeSync(fd); }
}
function moveFile(src, dest) {
  try { fs.renameSync(src, dest); }
  catch (e) { if (e.code === 'EXDEV') { fs.copyFileSync(src, dest); fs.unlinkSync(src); } else throw e; }
}
const rm = f => { try { fs.unlinkSync(f); } catch (e) { /* ignore */ } };

const pid = v => {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id.');
  return n;
};

const DOC_SELECT = `SELECT d.id, d.category, d.original_name, d.mime_type, d.size_bytes, d.uploaded_at, d.deleted_at,
  u.full_name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by`;

router.get('/students/:id/documents', (req, res) => {
  const sid = pid(req.params.id);
  if (!db.prepare('SELECT 1 FROM students WHERE id = ?').get(sid)) throw new HttpError(404, 'Student not found.');
  const showDeleted = req.query.deleted === '1' && req.user.role === 'admin';
  const rows = db.prepare(`${DOC_SELECT} WHERE d.student_id = ? AND ${showDeleted ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL'}
    ORDER BY d.uploaded_at DESC, d.id DESC`).all(sid);
  res.json({
    documents: rows.map(r => ({ ...r, previewable: PREVIEWABLE.has(r.mime_type) })),
    categories: CATEGORIES,
    max_upload_mb: config.MAX_UPLOAD_MB
  });
});

router.post('/students/:id/documents', canWrite, upload.array('files', 20), wrap(async (req, res) => {
  const files = req.files || [];
  const cleanup = () => files.forEach(f => rm(f.path));
  try {
    const sid = pid(req.params.id);
    const student = db.prepare(`SELECT s.id, s.record_id, c.slug AS class_slug, b.label AS batch_label
      FROM students s JOIN classes c ON c.id = s.class_id JOIN batches b ON b.id = c.batch_id WHERE s.id = ?`).get(sid);
    if (!student) throw new HttpError(404, 'Student not found.');
    if (!files.length) throw new HttpError(400, 'Choose at least one file to upload.');
    const category = CATEGORIES.includes(str(req.body.category, 40)) ? str(req.body.category, 40) : 'Other';

    const dirRel = path.join(student.batch_label, student.class_slug, student.record_id);
    const dirAbs = absFilePath(dirRel);
    fs.mkdirSync(dirAbs, { recursive: true });

    const saved = [], rejected = [];
    for (const f of files) {
      const original = Buffer.from(f.originalname, 'latin1').toString('utf8'); // multer decodes names as latin1
      const type = sniffType(readHead(f.path));
      if (!type) { rejected.push({ name: original, reason: 'Not a PDF, JPEG, PNG, WebP or TIFF file.' }); rm(f.path); continue; }
      if (f.size === 0) { rejected.push({ name: original, reason: 'The file is empty.' }); rm(f.path); continue; }
      const checksum = await sha256File(f.path);
      const dup = db.prepare('SELECT 1 FROM documents WHERE student_id = ? AND checksum = ? AND deleted_at IS NULL').get(sid, checksum);
      if (dup) { rejected.push({ name: original, reason: 'This exact file is already in the student\'s folder.' }); rm(f.path); continue; }

      const { base } = safeFileName(original);
      const stored_name = `${crypto.randomBytes(4).toString('hex')}_${base}${type.ext}`;
      moveFile(f.path, path.join(dirAbs, stored_name));
      const info = db.prepare(`INSERT INTO documents (student_id, category, original_name, stored_name, storage_path, mime_type, size_bytes, checksum, uploaded_by)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(sid, category, original.slice(0, 200), stored_name,
        path.posix.join(student.batch_label, student.class_slug, student.record_id, stored_name), type.mime, f.size, checksum, req.user.id);
      audit(req, 'document.upload', 'document', info.lastInsertRowid, `${student.record_id}: ${original} [${category}]`);
      saved.push({ id: info.lastInsertRowid, name: original });
    }
    res.status(saved.length ? 201 : 400).json({ uploaded: saved.length, rejected,
      error: saved.length ? undefined : (rejected[0] ? rejected[0].reason : 'Nothing was uploaded.') });
  } finally { cleanup(); }
}));

function loadDoc(req) {
  const id = pid(req.params.id);
  const d = db.prepare(`SELECT d.*, s.record_id FROM documents d JOIN students s ON s.id = d.student_id WHERE d.id = ?`).get(id);
  if (!d) throw new HttpError(404, 'Document not found.');
  if (d.deleted_at && req.user.role !== 'admin') throw new HttpError(404, 'Document not found.');
  return d;
}

router.get('/documents/:id/file', wrap(async (req, res) => {
  const d = loadDoc(req);
  let abs;
  try { abs = absFilePath(d.storage_path); } catch (e) { throw new HttpError(400, 'Invalid file location.'); }
  if (!fs.existsSync(abs)) {
    audit(req, 'document.missing', 'document', d.id, d.storage_path);
    throw new HttpError(404, 'The file is missing from storage. Please restore it from backup.');
  }
  const download = req.query.download === '1' || !PREVIEWABLE.has(d.mime_type);
  audit(req, download ? 'document.download' : 'document.view', 'document', d.id, `${d.record_id}: ${d.original_name}`);
  const asciiName = d.original_name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', d.mime_type);
  res.setHeader('Content-Length', fs.statSync(abs).size);
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(d.original_name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(abs).pipe(res);
}));

// Deleting only hides the document; the file stays on disk so it can be restored.
router.delete('/documents/:id', canWrite, wrap(async (req, res) => {
  const d = loadDoc(req);
  if (d.deleted_at) throw new HttpError(400, 'Already deleted.');
  db.prepare("UPDATE documents SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(req.user.id, d.id);
  audit(req, 'document.delete', 'document', d.id, `${d.record_id}: ${d.original_name}`);
  res.json({ ok: true });
}));

router.post('/documents/:id/restore', isAdmin, wrap(async (req, res) => {
  const d = loadDoc(req);
  if (!d.deleted_at) throw new HttpError(400, 'This document is not deleted.');
  db.prepare('UPDATE documents SET deleted_at = NULL, deleted_by = NULL WHERE id = ?').run(d.id);
  audit(req, 'document.restore', 'document', d.id, `${d.record_id}: ${d.original_name}`);
  res.json({ ok: true });
}));

module.exports = router;
