// Saves a safe copy of the database into backups/ and keeps the newest 14.
// Run by hand with `npm run backup`; the server also runs it on start and once a day.
const fs = require('fs');
const path = require('path');
const DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');

async function runBackup(db, keep = 14) {
  fs.mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const file = path.join(DIR, `nook-${stamp}.db`);
  await db.backup(file);
  const all = fs.readdirSync(DIR).filter((f) => /^nook-.*\.db$/.test(f)).sort();
  all.slice(0, Math.max(0, all.length - keep)).forEach((f) => fs.unlinkSync(path.join(DIR, f)));
  return file;
}

module.exports = { runBackup };

if (require.main === module) {
  const Database = require('better-sqlite3');
  const db = new Database(path.join(__dirname, 'data', 'nook.db'), { fileMustExist: true });
  runBackup(db)
    .then((f) => { console.log('Backup saved to', f); db.close(); })
    .catch((e) => { console.error('Backup failed:', e.message); process.exit(1); });
}
