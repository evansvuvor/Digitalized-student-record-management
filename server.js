'use strict';
const os = require('os');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const multer = require('multer');

const config = require('./config');
const db = require('./db');
const SQLiteStore = require('./lib/sessionStore');
const A = require('./lib/auth');
const { HttpError } = require('./lib/helpers');

const app = express();
if (config.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(config.TRUST_PROXY) ? parseInt(config.TRUST_PROXY, 10) : config.TRUST_PROXY);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // Allow plain-HTTP use on the school network; switch to HTTPS + COOKIE_SECURE=true when available.
      'upgrade-insecure-requests': config.COOKIE_SECURE ? [] : null,
      'img-src': ["'self'", 'data:'],
      'frame-src': ["'self'"]
    }
  },
  hsts: config.COOKIE_SECURE
}));

app.use(express.json({ limit: '200kb' }));

app.use(session({
  name: 'spaco.sid',
  secret: config.SESSION_SECRET,
  store: new SQLiteStore(),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.COOKIE_SECURE, maxAge: config.SESSION_HOURS * 3600 * 1000 }
}));

app.use('/api', A.csrfGuard);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api', require('./routes/records'));
app.use('/api', require('./routes/documents'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.get('/api-config.json', (req, res) => res.json({ school: config.SCHOOL_NAME }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: 0 }));

// Central error handler: friendly JSON for expected errors, generic message for bugs.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `A file is larger than the ${config.MAX_UPLOAD_MB} MB limit.`
      : err.code === 'LIMIT_FILE_COUNT' ? 'Please upload at most 20 files at a time.' : 'Upload failed.';
    return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: msg });
  }
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// First run: create an administrator with a one-time random password.
function ensureFirstAdmin() {
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (n > 0) return;
  const pw = A.randomPassword();
  db.prepare("INSERT INTO users (username, full_name, password_hash, role, must_change_password) VALUES ('admin','Administrator',?, 'admin', 1)")
    .run(A.hashPassword(pw));
  const line = '='.repeat(62);
  console.log(`\n${line}\n  FIRST RUN — administrator account created\n\n    Username: admin\n    Password: ${pw}\n\n  You will be asked to choose a new password at first sign-in.\n  This password is shown only once. If you lose it, run:\n    npm run reset-admin\n${line}\n`);
}
ensureFirstAdmin();

const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`${config.SCHOOL_NAME} — Document Vault running`);
  console.log(`  This computer:  http://localhost:${config.PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) console.log(`  On the network: http://${a.address}:${config.PORT}`);
  }
  console.log(`  Data folder:    ${config.DATA_DIR}\n`);
});

function shutdown() { server.close(() => { try { db.close(); } catch (e) { /* ignore */ } process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
