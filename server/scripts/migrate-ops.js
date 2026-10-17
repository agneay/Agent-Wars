// Usage: node scripts/migrate-ops.js up|down
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const direction = process.argv[2] || 'up';
if (!['up', 'down'].includes(direction)) {
  console.error('Usage: node scripts/migrate-ops.js up|down');
  process.exit(1);
}

const file = path.join(here, '..', 'migrations', `001_ops.${direction}.sql`);
const statements = fs.readFileSync(file, 'utf8')
  .split(/;\s*$/m)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);

let applied = 0, skipped = 0;
for (const sql of statements) {
  try {
    await pool.query(sql);
    applied++;
  } catch (e) {
    // Re-running is safe: duplicate/missing index errors are expected on repeat runs.
    if (['ER_DUP_KEYNAME', 'ER_CANT_DROP_FIELD_OR_KEY'].includes(e.code)) { skipped++; continue; }
    console.error(`Failed: ${sql.slice(0, 80)}...\n  ${e.code}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`migrate ${direction}: ${applied} applied, ${skipped} already in place`);
process.exit(0);
