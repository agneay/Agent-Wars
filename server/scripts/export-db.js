// Exports the local database (schema + data) to db/aai_asset_dump.sql using mysqldump.
// Usage: node scripts/export-db.js   (reads DB_* from .env; password passed via env, never on the command line)
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'db', 'aai_asset_dump.sql');
const candidates = [process.env.MYSQLDUMP, 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqldump.exe', 'mysqldump'].filter(Boolean);
const bin = candidates.find(c => c === 'mysqldump' || fs.existsSync(c));
const args = ['-h', process.env.DB_HOST || 'localhost', '-P', process.env.DB_PORT || '3306', '-u', process.env.DB_USER || 'root',
  '--single-transaction', '--no-tablespaces', '--set-gtid-purged=OFF', '--skip-comments', '--default-character-set=utf8mb4', process.env.DB_NAME || 'aai_asset'];
const child = spawn(bin, args, { env: { ...process.env, MYSQL_PWD: process.env.DB_PASSWORD || '' } });
child.stdout.pipe(fs.createWriteStream(out));
child.stderr.on('data', d => process.stderr.write(d));
child.on('close', code => {
  if (code !== 0) { console.error(`mysqldump exited with ${code}`); process.exit(code); }
  console.log(`Wrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
});
