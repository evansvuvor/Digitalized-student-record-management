'use strict';
// Usage: npm run verify
// Checks every stored document: the file must exist and match the checksum recorded at upload.
// Run it monthly (or after moving the data folder) to catch missing or corrupted scans early.
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { absFilePath } = require('../lib/helpers');

const docs = db.prepare('SELECT id, storage_path, checksum, original_name FROM documents').all();
let ok = 0; const missing = [], corrupt = [];
for (const d of docs) {
  let abs; try { abs = absFilePath(d.storage_path); } catch (e) { missing.push(d); continue; }
  if (!fs.existsSync(abs)) { missing.push(d); continue; }
  const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (h === d.checksum) ok++; else corrupt.push(d);
}
console.log(`Checked ${docs.length} documents: ${ok} OK, ${missing.length} missing, ${corrupt.length} corrupted.`);
missing.forEach(d => console.log(`  MISSING   #${d.id} ${d.storage_path}`));
corrupt.forEach(d => console.log(`  CORRUPTED #${d.id} ${d.storage_path}`));
if (missing.length || corrupt.length) console.log('Restore the affected files from your latest backup.');
db.close();
process.exit(missing.length || corrupt.length ? 2 : 0);
