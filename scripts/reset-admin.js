'use strict';
// Usage: npm run reset-admin            (resets/creates the user "admin")
//        npm run reset-admin -- jdoe    (resets/creates user "jdoe" as an administrator)
// Prints a one-time password; the user must change it at next sign-in.
const db = require('../db');
const A = require('../lib/auth');

const username = (process.argv[2] || 'admin').trim();
const pw = A.randomPassword();
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  db.prepare("UPDATE users SET password_hash=?, role='admin', is_active=1, must_change_password=1 WHERE id=?").run(A.hashPassword(pw), existing.id);
  db.prepare('DELETE FROM sessions WHERE sess LIKE ? OR sess LIKE ?').run(`%"userId":${existing.id},%`, `%"userId":${existing.id}}%`);
} else {
  db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES (?,?,?,'admin',1)")
    .run(username, username, A.hashPassword(pw));
}
db.prepare("INSERT INTO audit_log (username, action, entity, detail) VALUES (?, 'admin.reset_cli', 'user', ?)").run('(server console)', username);
console.log(`\nAdministrator "${username}" is ready.\n  Temporary password: ${pw}\n  They must choose a new password at next sign-in.\n`);
db.close();
