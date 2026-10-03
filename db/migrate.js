// Creates / updates all tables:   npm run db:setup
// Safe to run repeatedly. Reads db/schema.sql and executes it.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool } = require('./postgres');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log(
    `Connecting to ${process.env.DB_NAME || 'metaval_foundry'} as ${process.env.DB_USER || 'metaval_app'} ...`
  );

  await pool.query(sql); // the file has its own BEGIN ... COMMIT

  const { rows } = await pool.query(`
    SELECT table_schema, count(*)::int AS tables
    FROM information_schema.tables
    WHERE table_schema IN ('core','casting','ingot') AND table_type = 'BASE TABLE'
    GROUP BY table_schema ORDER BY table_schema`);
  console.log('Database ready:');
  console.table(rows);
}

main()
  .catch((err) => {
    console.error('\nDatabase setup FAILED:', err.message);
    if (err.code === '28P01') console.error('-> Wrong DB_USER / DB_PASSWORD in .env');
    if (err.code === '3D000') console.error('-> Database does not exist. Run db/00_create_database.sql first.');
    if (err.code === 'ECONNREFUSED') console.error('-> PostgreSQL is not running / wrong DB_HOST or DB_PORT.');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
