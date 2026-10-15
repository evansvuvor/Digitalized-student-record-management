'use strict';
// Usage: npm run backup
// 1) Takes a consistent snapshot of the database.  2) Copies any new/changed scanned files.
// Never deletes anything from the backup location. Point BACKUP_DIR (in .env) at an external
// drive or a synced cloud folder, and schedule this to run nightly.
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');

const KEEP = parseInt(process.env.BACKUP_KEEP || '30', 10);

function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyNewFiles(srcDir, destDir, stats) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, entry.name), d = path.join(destDir, entry.name);
    if (entry.isDirectory()) { copyNewFiles(s, d, stats); continue; }
    const ss = fs.statSync(s);
    if (fs.existsSync(d) && fs.statSync(d).size === ss.size) { stats.skipped++; continue; }
    fs.copyFileSync(s, d); stats.copied++; stats.bytes += ss.size;
  }
}

(async () => {
  const dbDir = path.join(config.BACKUP_DIR, 'database');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, `vault-${stamp()}.db`);
  await db.backup(dbFile);

  // Make the snapshot a single self-contained file (no -wal/-shm sidecars), then verify it.
  const Database = require('better-sqlite3');
  const check = new Database(dbFile);
  check.pragma('journal_mode = DELETE');
  const result = check.pragma('integrity_check', { simple: true });
  check.close();
  if (result !== 'ok') { console.error('Database backup FAILED integrity check:', result); process.exit(1); }

  const old = fs.readdirSync(dbDir).filter(f => /^vault-.*\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - KEEP))) fs.unlinkSync(path.join(dbDir, f));

  const stats = { copied: 0, skipped: 0, bytes: 0 };
  copyNewFiles(config.FILES_DIR, path.join(config.BACKUP_DIR, 'files'), stats);

  console.log(`Backup complete → ${config.BACKUP_DIR}`);
  console.log(`  Database snapshot: ${path.basename(dbFile)} (integrity: ok, keeping latest ${KEEP})`);
  console.log(`  Scanned files: ${stats.copied} copied (${(stats.bytes / 1048576).toFixed(1)} MB), ${stats.skipped} already backed up`);
  db.close();
})().catch(e => { console.error('Backup failed:', e.message); process.exit(1); });
