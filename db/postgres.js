const { Pool, types } = require('pg');

// By default pg returns BIGINT (int8) and NUMERIC as strings. Our ids and
// weights/percentages are small enough to be plain JS numbers, so convert them.
types.setTypeParser(20, (v) => Number(v));      // int8 / bigint
types.setTypeParser(1700, (v) => parseFloat(v));  // numeric

// ---------------------------------------------------------------------
// >>> CONNECTION SETTINGS COME FROM YOUR .env FILE <<<
// DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD
// ---------------------------------------------------------------------
const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'metaval_foundry',
  user: process.env.DB_USER || 'metaval_app',
  password: process.env.DB_PASSWORD,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

/** Run one query: query('SELECT * FROM core.users WHERE id = $1', [5]) */
function query(text, params) {
  return pool.query(text, params);
}

/** Run several statements atomically. Everything commits together or rolls back together. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function testPostgresConnection() {
  const client = await pool.connect();

  try {
    const result = await client.query(
      'SELECT current_user, current_database(), version()'
    );

    console.log('PostgreSQL connection successful:');
    console.log(result.rows[0]);
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
  testPostgresConnection,
};
