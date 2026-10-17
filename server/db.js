import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Hosted MySQL (Railway, Aiven, TiDB Cloud...) usually gives one connection URL and requires TLS.
// DATABASE_URL (or Railway's MYSQL_URL) wins over the individual DB_* variables.
const url = process.env.DATABASE_URL || process.env.MYSQL_URL;
const ssl = process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2', rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined;

const common = {
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  ...(ssl ? { ssl } : {}),
};

const pool = url
  ? mysql.createPool({ uri: url, ...common })
  : mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'aai_asset',
      ...common,
    });

export default pool;
