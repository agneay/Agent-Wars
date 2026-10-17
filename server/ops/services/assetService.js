// Validated data access for AirportOps AI. All SQL is parameterised; the model never writes SQL.
// Read functions take a counted pool; mutation functions take a counted connection that is
// already inside a transaction (see mcp/tools.js runMutation).
import crypto from 'crypto';
import { OpsError } from '../util.js';

const isSynthetic = id => typeof id === 'string' && id.startsWith('DEMO-');

const ASSET_SELECT = `
  SELECT a.asset_id, aty.asset_type_name AS type, b.brand_name AS make, dm.model_name AS model,
         a.serial_number AS serial, DATE_FORMAT(a.purchase_date, '%Y-%m-%d') AS purchase_date,
         DATE_FORMAT(a.warranty_end_date, '%Y-%m-%d') AS warranty_end_date,
         st.status_name AS status, l.location_name AS location, v.vendor_name AS vendor
  FROM assets a
  LEFT JOIN asset_types aty ON a.asset_type_id = aty.asset_type_id
  LEFT JOIN device_models dm ON a.model_id = dm.model_id
  LEFT JOIN brands b ON dm.brand_id = b.brand_id
  LEFT JOIN asset_status st ON a.status_id = st.status_id
  LEFT JOIN locations l ON a.location_id = l.location_id
  LEFT JOIN vendors v ON a.vendor_id = v.vendor_id`;

const withFlags = a => a && ({ ...a, synthetic: isSynthetic(a.asset_id), warranty_valid: a.warranty_end_date ? a.warranty_end_date >= today() : null });
const today = () => new Date().toISOString().slice(0, 10);

const EMP_SELECT = `
  SELECT u.user_id, u.emp_id, u.employee_name, u.email, u.status, d.department_name AS department,
         g.designation_name AS designation, l.location_name AS location
  FROM users u
  LEFT JOIN departments d ON u.department_id = d.department_id
  LEFT JOIN designations g ON u.designation_id = g.designation_id
  LEFT JOIN locations l ON u.location_id = l.location_id`;

// ---------------------------------------------------------------- reads

export async function searchEmployees(db, { query, limit = 5 }) {
  const q = query.trim();
  const digits = q.replace(/\D/g, '');
  const [rows] = await db.query(`
    ${EMP_SELECT}
    WHERE u.emp_id = ? OR u.user_id = ? OR u.email = ?
       OR u.emp_id LIKE ? OR u.employee_name LIKE ?
       OR (? <> '' AND REGEXP_REPLACE(u.emp_id, '[^0-9]', '') = ?)
    LIMIT 25`, [q, q, q, `${q}%`, `%${q}%`, digits, digits]);
  const scored = rows.map(r => {
    let score = 0, match = 'name';
    if (r.emp_id.toLowerCase() === q.toLowerCase() || r.user_id === q || r.email === q) { score = 100; match = 'exact_id'; }
    else if (r.emp_id.toLowerCase().startsWith(q.toLowerCase())) { score = 70; match = 'id_prefix'; }
    else if (digits && r.emp_id.replace(/\D/g, '') === digits) { score = 60; match = 'id_digits'; }
    else if (r.employee_name.toLowerCase() === q.toLowerCase()) { score = 90; match = 'exact_name'; }
    else score = 40;
    return { ...r, synthetic: r.user_id.startsWith('demo-'), match, score };
  }).sort((a, b) => b.score - a.score).slice(0, limit);
  return scored;
}

export async function searchAssets(db, { query, asset_type, status, limit = 10 }) {
  const like = `%${query}%`;
  const params = [query, query, like, like, like, like, like];
  let where = `(a.asset_id = ? OR a.serial_number = ? OR a.asset_id LIKE ? OR a.serial_number LIKE ? OR dm.model_name LIKE ?
     OR EXISTS (SELECT 1 FROM network_details n WHERE n.asset_id = a.asset_id AND (n.ip_address LIKE ? OR n.hostname LIKE ?)))`;
  if (asset_type) { where += ' AND aty.asset_type_name = ?'; params.push(asset_type); }
  if (status) { where += ' AND st.status_name = ?'; params.push(status); }
  params.push(query, limit);
  const [rows] = await db.query(`${ASSET_SELECT} WHERE ${where} ORDER BY (a.asset_id = ?) DESC LIMIT ?`, params);
  return rows.map(withFlags);
}

export async function getEmployeeDetails(db, { user_id }) {
  const [[emp]] = await db.query(`${EMP_SELECT} WHERE u.user_id = ?`, [user_id]);
  if (!emp) throw new OpsError('NOT_FOUND', `Employee ${user_id} does not exist`);
  const [assets] = await db.query(`
    ${ASSET_SELECT}
    JOIN user_asset_assignment x ON x.asset_id = a.asset_id AND x.returned_date IS NULL
    WHERE x.user_id = ? ORDER BY aty.asset_type_name`, [user_id]);
  return { ...emp, synthetic: emp.user_id.startsWith('demo-'), active_assets: assets.map(withFlags) };
}

async function specsFor(db, asset_id) {
  const [[lap]] = await db.query(`
    SELECT p.processor_name AS processor, d.ram_size AS ram, d.storage_size AS storage,
           CONCAT_WS(' ', o.os_name, o.os_version) AS os, 'laptop' AS source
    FROM laptop_details d LEFT JOIN processors p ON d.processor_id = p.processor_id
    LEFT JOIN operating_systems o ON d.os_id = o.os_id WHERE d.asset_id = ?`, [asset_id]);
  if (lap) return lap;
  // Licence keys in cpu_details are deliberately not selected.
  const [[cpu]] = await db.query(`
    SELECT p.processor_name AS processor, d.ram_size AS ram, d.storage_size AS storage,
           CONCAT_WS(' ', o.os_name, o.os_version) AS os, d.office_suite, d.adobe_acrobat, 'cpu' AS source
    FROM cpu_details d LEFT JOIN processors p ON d.processor_id = p.processor_id
    LEFT JOIN operating_systems o ON d.os_id = o.os_id WHERE d.asset_id = ?`, [asset_id]);
  if (cpu) return cpu;
  const [[eq]] = await db.query('SELECT capacity, technology, data_field, \'equipment\' AS source FROM equipment_specs WHERE asset_id = ? LIMIT 1', [asset_id]);
  return eq || null;
}

export async function activeAssignment(db, asset_id) {
  const [[row]] = await db.query(`
    SELECT x.assignment_id, x.user_id, u.emp_id, u.employee_name, DATE_FORMAT(x.assigned_date, '%Y-%m-%d') AS assigned_date
    FROM user_asset_assignment x JOIN users u ON u.user_id = x.user_id
    WHERE x.asset_id = ? AND x.returned_date IS NULL ORDER BY x.assignment_id DESC LIMIT 1`, [asset_id]);
  return row || null;
}

async function activeReservation(db, asset_id) {
  const [[row]] = await db.query(`
    SELECT id, workflow_id, for_user_id, DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s') AS expires_at
    FROM ops_reservations WHERE asset_id = ? AND status = 'ACTIVE' AND expires_at > NOW(3)`, [asset_id]);
  return row || null;
}

export async function getAssetDetails(db, { asset_id }) {
  const [[a]] = await db.query(`${ASSET_SELECT} WHERE a.asset_id = ?`, [asset_id]);
  if (!a) throw new OpsError('NOT_FOUND', `Asset ${asset_id} does not exist`);
  const [specs, network, software, assignment, reservation] = await Promise.all([
    specsFor(db, asset_id), getNetworkDetails(db, { asset_id }), getSoftware(db, { asset_id }),
    activeAssignment(db, asset_id), activeReservation(db, asset_id),
  ]);
  return { ...withFlags(a), specs, network, software, active_assignment: assignment, active_reservation: reservation };
}

export async function getAssignmentHistory(db, { asset_id, user_id, limit = 25 }) {
  if (!asset_id && !user_id) throw new OpsError('VALIDATION_ERROR', 'asset_id or user_id is required');
  const [rows] = await db.query(`
    SELECT h.history_id, h.asset_id, h.user_id, u.emp_id, u.employee_name, h.assignment_status AS status,
           DATE_FORMAT(h.assigned_date, '%Y-%m-%d') AS assigned_date, DATE_FORMAT(h.returned_date, '%Y-%m-%d') AS returned_date,
           h.assigned_by, h.remarks
    FROM asset_assignment_history h LEFT JOIN users u ON u.user_id = h.user_id
    WHERE ${asset_id ? 'h.asset_id = ?' : 'h.user_id = ?'}
    ORDER BY h.history_id DESC LIMIT ?`, [asset_id || user_id, limit]);
  return rows;
}

export async function getNetworkDetails(db, { asset_id }) {
  const [[n]] = await db.query(`
    SELECT ip_address, hostname, vlan, mac_ethernet, mac_wifi, mac_bluetooth FROM network_details WHERE asset_id = ?`, [asset_id]);
  return n || null;
}

export async function getSoftware(db, { asset_id }) {
  const [rows] = await db.query(`
    SELECT s.software_name, s.software_version, DATE_FORMAT(i.install_date, '%Y-%m-%d') AS install_date
    FROM asset_software_installation i JOIN software_master s ON s.software_id = i.software_id
    WHERE i.asset_id = ? ORDER BY s.software_name`, [asset_id]);
  return rows;
}

export async function getAvailableInventory(db, { asset_type, location, exclude_asset_ids = [], limit = 25 }) {
  const params = [asset_type];
  let extra = '';
  if (location) { extra += ' AND l.location_name = ?'; params.push(location); }
  if (exclude_asset_ids.length) { extra += ` AND a.asset_id NOT IN (${exclude_asset_ids.map(() => '?').join(',')})`; params.push(...exclude_asset_ids); }
  params.push(limit);
  const [rows] = await db.query(`
    SELECT a.asset_id, aty.asset_type_name AS type, b.brand_name AS make, dm.model_name AS model, a.serial_number AS serial,
           DATE_FORMAT(a.purchase_date, '%Y-%m-%d') AS purchase_date, DATE_FORMAT(a.warranty_end_date, '%Y-%m-%d') AS warranty_end_date,
           st.status_name AS status, l.location_name AS location,
           COALESCE(ld.ram_size, cd.ram_size) AS ram, COALESCE(ld.storage_size, cd.storage_size) AS storage,
           p.processor_name AS processor, CONCAT_WS(' ', o.os_name, o.os_version) AS os
    FROM assets a
    JOIN asset_types aty ON a.asset_type_id = aty.asset_type_id
    JOIN asset_status st ON a.status_id = st.status_id
    LEFT JOIN device_models dm ON a.model_id = dm.model_id
    LEFT JOIN brands b ON dm.brand_id = b.brand_id
    LEFT JOIN locations l ON a.location_id = l.location_id
    LEFT JOIN laptop_details ld ON ld.asset_id = a.asset_id
    LEFT JOIN cpu_details cd ON cd.asset_id = a.asset_id
    LEFT JOIN processors p ON p.processor_id = COALESCE(ld.processor_id, cd.processor_id)
    LEFT JOIN operating_systems o ON o.os_id = COALESCE(ld.os_id, cd.os_id)
    WHERE aty.asset_type_name = ? AND st.status_name = 'Available'
      AND NOT EXISTS (SELECT 1 FROM user_asset_assignment x WHERE x.asset_id = a.asset_id AND x.returned_date IS NULL)
      AND NOT EXISTS (SELECT 1 FROM ops_reservations r WHERE r.asset_id = a.asset_id AND r.status = 'ACTIVE' AND r.expires_at > NOW(3))
      ${extra}
    ORDER BY a.asset_id LIMIT ?`, params);
  return rows.map(withFlags);
}

export async function getAssetStatus(db, { asset_ids }) {
  const [rows] = await db.query(`
    SELECT a.asset_id, st.status_name AS status,
      (SELECT x.user_id FROM user_asset_assignment x WHERE x.asset_id = a.asset_id AND x.returned_date IS NULL ORDER BY x.assignment_id DESC LIMIT 1) AS assigned_user_id,
      (SELECT COUNT(*) FROM user_asset_assignment x WHERE x.asset_id = a.asset_id AND x.returned_date IS NULL) AS active_assignment_count,
      (SELECT r.id FROM ops_reservations r WHERE r.asset_id = a.asset_id AND r.status = 'ACTIVE' AND r.expires_at > NOW(3) LIMIT 1) AS active_reservation_id
    FROM assets a LEFT JOIN asset_status st ON a.status_id = st.status_id
    WHERE a.asset_id IN (${asset_ids.map(() => '?').join(',')})`, asset_ids);
  const found = new Map(rows.map(r => [r.asset_id, { ...r, active_assignment_count: Number(r.active_assignment_count) }]));
  return asset_ids.map(id => found.get(id) || { asset_id: id, exists: false });
}

export async function getReservation(db, { reservation_id }) {
  const [[r]] = await db.query('SELECT id, asset_id, workflow_id, for_user_id, status, expires_at FROM ops_reservations WHERE id = ?', [reservation_id]);
  return r || null;
}

// ---------------------------------------------------------------- mutations (inside a transaction)

const statusCache = new Map();
async function statusId(conn, name) {
  if (statusCache.has(name)) return statusCache.get(name);
  const [[row]] = await conn.query('SELECT status_id FROM asset_status WHERE status_name = ?', [name]);
  if (!row) throw new OpsError('VALIDATION_ERROR', `Unknown asset status "${name}"`);
  statusCache.set(name, row.status_id);
  return row.status_id;
}

async function lockAsset(conn, asset_id) {
  const [[row]] = await conn.query(`
    SELECT a.asset_id, st.status_name AS status FROM assets a
    LEFT JOIN asset_status st ON a.status_id = st.status_id WHERE a.asset_id = ? FOR UPDATE`, [asset_id]);
  if (!row) throw new OpsError('NOT_FOUND', `Asset ${asset_id} does not exist`);
  return row;
}

async function requireActiveUser(conn, user_id) {
  const [[u]] = await conn.query('SELECT user_id, emp_id, employee_name, status FROM users WHERE user_id = ?', [user_id]);
  if (!u) throw new OpsError('NOT_FOUND', `Employee ${user_id} does not exist`);
  if (u.status && u.status !== 'Active') throw new OpsError('INVALID_STATE', `Employee ${u.emp_id} is ${u.status}, not Active`);
  return u;
}

const note = (remarks, workflow_id) => `${remarks}${workflow_id ? ` [AirportOps workflow ${workflow_id}]` : ''}`;

async function doAssign(conn, { asset_id, user_id, actor, remarks, reservation_id, workflow_id }) {
  const asset = await lockAsset(conn, asset_id);
  const user = await requireActiveUser(conn, user_id);
  const current = await activeAssignment(conn, asset_id);
  if (current) throw new OpsError('ALREADY_ASSIGNED', `Asset ${asset_id} is already assigned to ${current.emp_id}`, { details: { assigned_to: current.user_id } });
  if (asset.status !== 'Available') throw new OpsError('INVALID_STATE', `Asset ${asset_id} is ${asset.status}, not Available`);
  await conn.query("UPDATE ops_reservations SET status = 'EXPIRED', updated_at = NOW(3) WHERE asset_id = ? AND status = 'ACTIVE' AND expires_at <= NOW(3)", [asset_id]);
  const res = await activeReservation(conn, asset_id);
  if (res && res.id !== reservation_id) throw new OpsError('RESERVED', `Asset ${asset_id} is reserved by workflow ${res.workflow_id}`);
  if (res) await conn.query("UPDATE ops_reservations SET status = 'CONSUMED', updated_at = NOW(3) WHERE id = ?", [res.id]);
  const [ins] = await conn.query('INSERT INTO user_asset_assignment (user_id, asset_id, assigned_date) VALUES (?, ?, NOW())', [user_id, asset_id]);
  await conn.query(`
    INSERT INTO asset_assignment_history (asset_id, user_id, assigned_date, assignment_status, remarks, assigned_by)
    VALUES (?, ?, NOW(), 'Assigned', ?, ?)`, [asset_id, user_id, note(remarks || 'Asset assigned to user', workflow_id), actor]);
  await conn.query('UPDATE assets SET status_id = ? WHERE asset_id = ?', [await statusId(conn, 'Assigned'), asset_id]);
  return { asset_id, user_id, emp_id: user.emp_id, assignment_id: ins.insertId, reservation_consumed: res?.id || null, previous_status: asset.status, new_status: 'Assigned' };
}

async function doWithdraw(conn, { asset_id, return_status = 'Available', actor, remarks, workflow_id, expected_user_id }) {
  const asset = await lockAsset(conn, asset_id);
  const current = await activeAssignment(conn, asset_id);
  if (!current) throw new OpsError('NOT_ASSIGNED', `Asset ${asset_id} is not currently assigned`);
  if (expected_user_id && current.user_id !== expected_user_id) {
    throw new OpsError('ASSIGNMENT_MISMATCH', `Asset ${asset_id} is assigned to ${current.emp_id}, not the expected employee`);
  }
  await conn.query('UPDATE user_asset_assignment SET returned_date = NOW() WHERE assignment_id = ?', [current.assignment_id]);
  await conn.query(`
    INSERT INTO asset_assignment_history (asset_id, user_id, returned_date, assignment_status, remarks, returned_to_store, assigned_by)
    VALUES (?, ?, NOW(), 'Returned', ?, TRUE, ?)`, [asset_id, current.user_id, note(remarks || 'Asset returned to store', workflow_id), actor]);
  await conn.query('UPDATE assets SET status_id = ? WHERE asset_id = ?', [await statusId(conn, return_status), asset_id]);
  return { asset_id, from_user_id: current.user_id, from_emp_id: current.emp_id, assignment_id: current.assignment_id, previous_status: asset.status, new_status: return_status };
}

export const assignAsset = (conn, args) => doAssign(conn, args);
export const withdrawAsset = (conn, args) => doWithdraw(conn, args);

export async function updateAssetStatus(conn, { asset_id, status, expected_status, actor, remarks, workflow_id }) {
  const asset = await lockAsset(conn, asset_id);
  if (expected_status && asset.status !== expected_status) {
    throw new OpsError('STALE_STATE', `Asset ${asset_id} is ${asset.status}; expected ${expected_status}. Re-read before updating.`, { retryable: false });
  }
  const assigned = await activeAssignment(conn, asset_id);
  if (status === 'Assigned' && !assigned) throw new OpsError('INVALID_STATE', 'Use assign_asset to mark an asset Assigned');
  if (assigned && status === 'Available') throw new OpsError('INVALID_STATE', `Asset ${asset_id} is assigned to ${assigned.emp_id}; withdraw it first`);
  await conn.query('UPDATE assets SET status_id = ? WHERE asset_id = ?', [await statusId(conn, status), asset_id]);
  await conn.query(`
    INSERT INTO asset_assignment_history (asset_id, user_id, assigned_date, assignment_status, remarks, assigned_by)
    VALUES (?, ?, NOW(), 'Status Changed', ?, ?)`, [asset_id, assigned?.user_id || null, note(remarks || `Status ${asset.status} -> ${status}`, workflow_id), actor]);
  return { asset_id, previous_status: asset.status, new_status: status };
}

export async function transferAsset(conn, { asset_id, to_user_id, actor, remarks, workflow_id }) {
  const withdrawn = await doWithdraw(conn, { asset_id, actor, remarks: remarks || 'Transfer out', workflow_id });
  if (withdrawn.from_user_id === to_user_id) throw new OpsError('VALIDATION_ERROR', 'Asset is already assigned to that employee');
  const assigned = await doAssign(conn, { asset_id, user_id: to_user_id, actor, remarks: remarks || 'Transfer in', workflow_id });
  return { withdrawn, assigned };
}

export async function replaceAsset(conn, { user_id, old_asset_id, new_asset_id, old_asset_status = 'Maintenance', reservation_id, actor, remarks, workflow_id }) {
  if (old_asset_id === new_asset_id) throw new OpsError('VALIDATION_ERROR', 'Replacement must be a different asset');
  // Lock in a stable order so two concurrent replacements cannot deadlock each other.
  for (const id of [old_asset_id, new_asset_id].sort()) await lockAsset(conn, id);
  const withdrawn = await doWithdraw(conn, {
    asset_id: old_asset_id, return_status: old_asset_status, actor, workflow_id, expected_user_id: user_id,
    remarks: remarks ? `Replaced: ${remarks}` : 'Withdrawn for replacement',
  });
  const assigned = await doAssign(conn, {
    asset_id: new_asset_id, user_id, actor, reservation_id, workflow_id,
    remarks: `Replacement for ${old_asset_id}`,
  });
  return { withdrawn, assigned };
}

export async function createEmployee(conn, { user_id, emp_id, employee_name, email }) {
  // Lock any existing row with this emp_id so two concurrent creates cannot both pass the check.
  const [[dup]] = await conn.query('SELECT user_id, employee_name FROM users WHERE emp_id = ? FOR UPDATE', [emp_id]);
  if (dup) throw new OpsError('DUPLICATE_EMPLOYEE', `Employee ID ${emp_id} already exists (${dup.employee_name})`);
  await conn.query(
    "INSERT INTO users (user_id, emp_id, employee_name, email, status) VALUES (?, ?, ?, ?, 'Active')",
    [user_id, emp_id, employee_name, email || null]);
  return { user_id, emp_id, employee_name, email: email || null, status: 'Active' };
}

export async function reserveAsset(conn, { asset_id, workflow_id, for_user_id, ttl_minutes = 30, actor }) {
  const asset = await lockAsset(conn, asset_id);
  if (await activeAssignment(conn, asset_id)) throw new OpsError('ALREADY_ASSIGNED', `Asset ${asset_id} is already assigned`);
  if (asset.status !== 'Available') throw new OpsError('INVALID_STATE', `Asset ${asset_id} is ${asset.status}, not Available`);
  await conn.query("UPDATE ops_reservations SET status = 'EXPIRED', updated_at = NOW(3) WHERE asset_id = ? AND status = 'ACTIVE' AND expires_at <= NOW(3)", [asset_id]);
  const existing = await activeReservation(conn, asset_id);
  if (existing) {
    if (workflow_id && existing.workflow_id === workflow_id) return { reservation_id: existing.id, asset_id, expires_at: existing.expires_at, reused: true };
    throw new OpsError('RESERVED', `Asset ${asset_id} is already reserved by workflow ${existing.workflow_id}`);
  }
  const id = crypto.randomUUID();
  await conn.query(`
    INSERT INTO ops_reservations (id, asset_id, workflow_id, for_user_id, status, reserved_by, expires_at)
    VALUES (?, ?, ?, ?, 'ACTIVE', ?, DATE_ADD(NOW(3), INTERVAL ? MINUTE))`, [id, asset_id, workflow_id || null, for_user_id || null, actor, ttl_minutes]);
  const [[r]] = await conn.query("SELECT DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s') AS expires_at FROM ops_reservations WHERE id = ?", [id]);
  return { reservation_id: id, asset_id, expires_at: r.expires_at, reused: false };
}

export async function releaseReservation(conn, { reservation_id }) {
  const [res] = await conn.query("UPDATE ops_reservations SET status = 'RELEASED', updated_at = NOW(3) WHERE id = ? AND status = 'ACTIVE'", [reservation_id]);
  return { reservation_id, released: res.affectedRows === 1 };
}
