# Spaco Document Vault

A web application for storing scanned student documents for St. Paul's SHS & Minor Seminary,
for **both current students and alumni**.

Everything is filed **Year batch → Class → Student → Documents**, exactly as it is on disk:

```
data/files/
  2023/                      ← year batch
    science-a/               ← class
      SPC-2023-0001/         ← student (permanent record ID, not their name)
        3fa9c2d1_birth-certificate.pdf
        a62afecc_bece-results-slip.jpg
```

**What it does:** individual staff logins · three roles (Administrator / Registrar / Viewer) ·
batches, classes and students · bulk-paste a whole class list · drag-and-drop uploads · preview and
download · move a student to another class (their files move too) · global search · soft delete with
restore · full audit log · backup and integrity-check tools.

**What it needs:** one computer that stays on (an office PC is fine) running [Node.js](https://nodejs.org) 18 or newer.
Staff open it in a web browser from any device on the school network. No internet connection is required.

---

## 1. Install and start

```
cd spaco-vault
npm install
npm start
```

On the **first start** the console prints a one-time administrator password:

```
  FIRST RUN — administrator account created
    Username: admin
    Password: xxxxxxxxxxxx
```

Open **http://localhost:3000**, sign in, and you will be made to choose your own password.
The console also lists the address other computers use, e.g. `http://192.168.1.20:3000`.
If Windows Firewall asks, allow Node.js on **private** networks.

Lost the password? On the server, run `npm run reset-admin` for a new temporary one.

## 2. First-day setup (in the app)

1. **Users** → add a login for each staff member. Give each person the lowest role that lets them do their job.
2. Home → **+ New batch** (e.g. `2023`). Pick one rule for what "batch" means (admission year or completion year) and use it for every batch.
3. Open the batch → **+ New class** (e.g. `Science A`).
4. Open the class → **Add several students**, paste the class list, one name per line.
5. Open a student → drag in the scanned pages, choose the document type, **Upload**.

| Role | Can do |
|---|---|
| Administrator | Everything, plus staff accounts, the audit log, restoring deleted documents |
| Registrar | Add/edit batches, classes, students; upload and delete documents |
| Viewer | Search, read, preview and download only |

## 3. Digitising the old paper records (suggested order)

1. Create batches back to the oldest records you hold; bulk-paste each class list.
2. Scan **one batch at a time**, newest first. Scan to PDF (or JPEG) at 200–300 dpi, one file per document.
3. Upload straight into each student's folder. The class page shows a **none** badge beside students who still have no scans, so you can see what is left.
4. Keep the paper originals in a dry, locked room, boxed by batch and class, until the digital copies have been backed up and checked.

## 4. Backups — do not skip this

A vault with no backup only moves the risk from a filing cabinet to one hard drive.

```
npm run backup     # copies the database + any new scans to BACKUP_DIR
npm run verify     # checks every scan exists and is uncorrupted
```

* Set `BACKUP_DIR` in `.env` to an **external drive** (or a folder synced to cloud storage).
* Schedule `npm run backup` **nightly**. Windows: Task Scheduler → run `npm run backup` in the app folder.
  Linux: `0 2 * * * cd /opt/spaco-vault && npm run backup`.
* Keep a **second copy off the premises** (a drive kept at the parish or diocesan office), refreshed monthly.
* Run `npm run verify` monthly. It tells you exactly which files to restore from backup.
* **Restore:** stop the app, copy `database/vault-<latest>.db` to `data/vault.db`, copy `files/` back to `data/files/`, start the app.
* Backups never delete anything, so files removed from the vault remain in the backup.
* **Do a test restore once** on another computer to prove the backups work.

## 5. Keeping it running

* **Windows:** install [NSSM](https://nssm.cc) or use `pm2` so the app starts when the PC boots:
  `npm install -g pm2 && pm2 start server.js --name spaco-vault && pm2 save` (then `pm2-startup`).
* **Linux:** a `systemd` service or `pm2`.
* Give the server PC a **fixed IP address** (ask whoever manages your router) so the address staff use never changes.
* Put the server on a **UPS** if power is unreliable. Sudden power loss is the main risk to any database.

## 6. Security — read before real data goes in

Built in: bcrypt-hashed passwords · individual accounts · forced change of temporary passwords ·
login lockout after 10 failed attempts · sessions stored server-side and revoked when an account is deactivated ·
upload type checked from file contents (not the filename) · files served only to signed-in users ·
nothing is permanently deleted by users · every view, upload, change and sign-in is audited.

**You still need to decide:**

* **Network.** By default the app speaks plain HTTP, which is acceptable on a private school network but means
  passwords and scans cross the network unencrypted. **Do not expose it to the internet as-is.** To use it remotely,
  put it behind a reverse proxy with HTTPS (e.g. [Caddy](https://caddyserver.com), which obtains certificates automatically),
  then set `COOKIE_SECURE=true` and `TRUST_PROXY=1` in `.env`.
* **Physical access.** Anyone who can log into the server PC or copy `data/` can read every record. Restrict access to that machine and consider disk encryption (BitLocker on Windows).
* **Data protection.** These are children's records. Ghana's Data Protection Act, 2012 (Act 843) applies; agree who may access what, and have the school's data-protection lead review your retention and disposal policy.
* **Passwords.** Never share accounts. Deactivate accounts the day someone leaves.

## 7. Technical notes

* Node.js + Express, SQLite database (`data/vault.db`), scans as ordinary files in `data/files/`.
* To move the system to another computer: stop it, copy the whole `data/` folder and `.env`, run `npm install` there.
* Accepted uploads: PDF, JPEG, PNG, WebP, TIFF (TIFF downloads but does not preview in browsers). Duplicates within one student's folder are refused.
* Deleting a document hides it; the file stays on disk and an administrator can restore it. Removing files permanently is a deliberate manual task on the server.
* Moving a student to another class moves their folder on disk; their record ID never changes.
* SQLite handles a school's records comfortably (tens of thousands of students). If you later outgrow it, the schema is in `db.js`.
* Files: `server.js` (startup) · `routes/` (API) · `lib/` (auth, helpers) · `public/` (the web interface) · `scripts/` (backup, verify, reset-admin).
