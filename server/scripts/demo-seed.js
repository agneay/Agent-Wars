// Seeds (or resets) SYNTHETIC demo data for the AirportOps AI scenarios.
// Every synthetic record is unmistakable: asset IDs start with "DEMO-", user IDs with "demo-",
// employee names with "[DEMO]", emails end in "@demo.invalid", and asset remarks say SYNTHETIC.
// Real records are never touched. Usage: node scripts/demo-seed.js [--reset-only]
import pool from '../db.js';

const SITE = 'DEMO Synthetic Site';
const TAG = 'SYNTHETIC DEMO DATA - safe to reset';

export async function resetDemoData(conn) {
  const demoAssets = "SELECT asset_id FROM assets WHERE asset_id LIKE 'DEMO-%'";
  await conn.query(`DELETE FROM ops_reservations WHERE asset_id IN (${demoAssets})`);
  await conn.query(`DELETE FROM asset_software_installation WHERE asset_id IN (${demoAssets})`);
  await conn.query(`DELETE FROM asset_assignment_history WHERE asset_id IN (${demoAssets}) OR user_id LIKE 'demo-%'`);
  await conn.query(`DELETE FROM user_asset_assignment WHERE asset_id IN (${demoAssets}) OR user_id LIKE 'demo-%'`);
  await conn.query("DELETE FROM assets WHERE asset_id LIKE 'DEMO-%'"); // cascades to detail tables
  await conn.query("DELETE FROM users WHERE user_id LIKE 'demo-%'");
}

async function idOf(conn, table, idCol, nameCol, name, extra = {}) {
  const cols = [nameCol, ...Object.keys(extra)];
  const where = cols.map(c => `${c} = ?`).join(' AND ');
  const vals = [name, ...Object.values(extra)];
  const [rows] = await conn.query(`SELECT ${idCol} AS id FROM ${table} WHERE ${where} LIMIT 1`, vals);
  if (rows[0]) return rows[0].id;
  const [res] = await conn.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  return res.insertId;
}

export async function seedDemoData(conn) {
  const loc = await idOf(conn, 'locations', 'location_id', 'location_name', SITE);
  const dept = await idOf(conn, 'departments', 'department_id', 'department_name', 'IT Operations');
  const desig = await idOf(conn, 'designations', 'designation_id', 'designation_name', 'Sr. Engineer');
  const stores = await idOf(conn, 'locations', 'location_id', 'location_name', 'CNS Stores');
  const type = n => idOf(conn, 'asset_types', 'asset_type_id', 'asset_type_name', n);
  const status = n => idOf(conn, 'asset_status', 'status_id', 'status_name', n);
  const brand = n => idOf(conn, 'brands', 'brand_id', 'brand_name', n);
  const model = async (b, m) => idOf(conn, 'device_models', 'model_id', 'model_name', m, { brand_id: await brand(b) });
  const proc = n => idOf(conn, 'processors', 'processor_id', 'processor_name', n);
  const os = await idOf(conn, 'operating_systems', 'os_id', 'os_name', 'Windows', { os_version: '11 Pro' });
  const [LAPTOP, MONITOR, PLOTTER] = [await type('Laptop'), await type('Monitor'), await type('Plotter')];
  const [AVAILABLE, ASSIGNED] = [await status('Available'), await status('Assigned')];

  const users = [
    ['demo-e102', 'E102', '[DEMO] Priya Nair'],
    ['demo-e201', 'E201', '[DEMO] Arjun Mehta'],
    ['demo-e301', 'E301', '[DEMO] Kavya Rao'],
  ];
  for (const [uid, emp, name] of users) {
    await conn.query(
      `INSERT INTO users (user_id, emp_id, employee_name, email, designation_id, department_id, location_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`,
      [uid, emp, name, `${emp.toLowerCase()}@demo.invalid`, desig, dept, loc]);
  }

  // [asset_id, type, brand, model, serial, purchase, warrantyEnd, location, laptopSpec?]
  const i5 = await proc('Intel Core i5-1235U');
  const i7 = await proc('Intel Core i7-1265U');
  const assets = [
    ['DEMO-LAP-0102', LAPTOP, 'Dell', 'Latitude 5430', 'DEMOSN0102', '2022-03-10', '2025-03-10', loc, [i5, '16GB', '512GB']],
    ['DEMO-LAP-2001', LAPTOP, 'HP', 'EliteBook 840', 'DEMOSN2001', '2025-06-01', '2028-06-01', loc, [i7, '16GB', '512GB']],
    ['DEMO-LAP-2002', LAPTOP, 'Lenovo', 'ThinkPad T14', 'DEMOSN2002', '2024-01-15', '2027-01-15', loc, [i5, '8GB', '256GB']],
    ['DEMO-LAP-2003', LAPTOP, 'Dell', 'Latitude 5430', 'DEMOSN2003', '2023-09-20', '2026-09-20', stores, [i7, '32GB', '1TB']],
    ['DEMO-LAP-0201', LAPTOP, 'Dell', 'Latitude 5430', 'DEMOSN0201', '2023-02-01', '2026-02-01', loc, [i5, '16GB', '512GB']],
    ['DEMO-LAP-0202', LAPTOP, 'Lenovo', 'ThinkPad T14', 'DEMOSN0202', '2024-05-05', '2027-05-05', loc, [i5, '16GB', '512GB']],
    ['DEMO-MON-0201', MONITOR, 'Dell', 'P2422H', 'DEMOSNM0201', '2023-02-01', '2026-02-01', loc, null],
    ['DEMO-PLT-0301', PLOTTER, 'HP', 'DesignJet T650', 'DEMOSNP0301', '2021-08-08', '2024-08-08', loc, null],
  ];
  for (const [id, t, b, m, serial, purchased, warranty, l, spec] of assets) {
    await conn.query(
      `INSERT INTO assets (asset_id, asset_type_id, model_id, serial_number, purchase_date, install_date, warranty_end_date, status_id, location_id, remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, t, await model(b, m), serial, purchased, purchased, warranty, AVAILABLE, l, TAG]);
    await conn.query(
      `INSERT INTO asset_assignment_history (asset_id, assigned_date, assignment_status, remarks, assigned_by)
       VALUES (?, ?, 'Created', 'Asset procured and added to inventory', 'demo-seed')`, [id, purchased]);
    if (spec) {
      await conn.query(
        `INSERT INTO laptop_details (asset_id, processor_id, ram_size, storage_size, os_id) VALUES (?, ?, ?, ?, ?)`,
        [id, spec[0], spec[1], spec[2], os]);
    }
  }

  const assign = async (assetId, userId, date) => {
    await conn.query('INSERT INTO user_asset_assignment (user_id, asset_id, assigned_date) VALUES (?, ?, ?)', [userId, assetId, date]);
    await conn.query(
      `INSERT INTO asset_assignment_history (asset_id, user_id, assigned_date, assignment_status, remarks, assigned_by)
       VALUES (?, ?, ?, 'Assigned', 'Asset assigned to user', 'demo-seed')`, [assetId, userId, date]);
    await conn.query('UPDATE assets SET status_id = ? WHERE asset_id = ?', [ASSIGNED, assetId]);
  };
  await assign('DEMO-LAP-0102', 'demo-e102', '2022-03-15');
  await assign('DEMO-LAP-0201', 'demo-e201', '2023-02-05');
  await assign('DEMO-LAP-0202', 'demo-e201', '2024-05-10');
  await assign('DEMO-MON-0201', 'demo-e201', '2023-02-05');
  await assign('DEMO-PLT-0301', 'demo-e301', '2021-08-10');

  // Prior maintenance event: evidence the Diagnostics agent can cite.
  await conn.query(
    `INSERT INTO asset_assignment_history (asset_id, user_id, assigned_date, assignment_status, remarks, assigned_by)
     VALUES ('DEMO-LAP-0102', 'demo-e102', '2024-11-02', 'Maintenance', 'Keyboard replaced after liquid spill; battery health 71%', 'demo-seed')`);

  await conn.query(
    `INSERT INTO network_details (asset_id, ip_address, hostname, vlan, mac_ethernet, mac_wifi)
     VALUES ('DEMO-LAP-0102', '10.99.0.102', 'DEMO-LT-0102', 'VLAN-DEMO-10', '00:00:5E:00:01:02', '00:00:5E:00:11:02')`);
  const [sw] = await conn.query('SELECT software_id FROM software_master ORDER BY software_id LIMIT 2');
  for (const s of sw) {
    await conn.query('INSERT INTO asset_software_installation (asset_id, software_id, install_date) VALUES (?, ?, ?)',
      ['DEMO-LAP-0102', s.software_id, '2022-03-15']);
  }
}

export async function reseed() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await resetDemoData(conn);
    await seedDemoData(conn);
    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('demo-seed.js')) {
  const resetOnly = process.argv.includes('--reset-only');
  try {
    if (resetOnly) {
      const conn = await pool.getConnection();
      await resetDemoData(conn);
      conn.release();
      console.log('Synthetic demo data removed.');
    } else {
      await reseed();
      console.log('Synthetic demo data seeded (E102, E201, E301; assets DEMO-*).');
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
