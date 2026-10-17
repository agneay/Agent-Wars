// Loads db/aai_asset_dump.sql into the database configured by DATABASE_URL / DB_* (e.g. a hosted MySQL).
// Usage: DATABASE_URL=mysql://... DB_SSL=true node scripts/import-db.js
// Refuses to run if the target already has tables, unless --force is given.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'db', 'aai_asset_dump.sql');
if (!fs.existsSync(file)) { console.error('Run node scripts/export-db.js first.'); process.exit(1); }

const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
const ssl = process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined;
const conn = url
  ? await mysql.createConnection({ uri: url, multipleStatements: true, ...(ssl ? { ssl } : {}) })
  : await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true, ...(ssl ? { ssl } : {}) });

const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
const [tables] = await conn.query('SHOW TABLES');
if (tables.length && !process.argv.includes('--force')) {
  console.error(`Target database "${db}" already has ${tables.length} tables. Re-run with --force to overwrite them.`);
  process.exit(1);
}
console.log(`Importing into "${db}"...`);
await conn.query(fs.readFileSync(file, 'utf8'));
const [after] = await conn.query('SHOW TABLES');
console.log(`Done: ${after.length} tables.`);
await conn.end();
