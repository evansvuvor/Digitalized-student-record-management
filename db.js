'use strict';
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(config.FILES_DIR, { recursive: true });
fs.mkdirSync(config.TMP_DIR, { recursive: true });

const db = new Database(config.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','registrar','viewer')),
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, name),
  UNIQUE (batch_id, slug)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  gender TEXT,
  date_of_birth TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  status TEXT NOT NULL DEFAULT 'current' CHECK (status IN ('current','alumni','transferred')),
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_students_class ON students(class_id);
CREATE INDEX IF NOT EXISTS idx_students_name ON students(full_name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
  category TEXT NOT NULL DEFAULT 'Other',
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,          -- relative to FILES_DIR
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  checksum TEXT NOT NULL,              -- sha256 of file contents
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_documents_student ON documents(student_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

module.exports = db;
