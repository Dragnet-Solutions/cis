import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

let _pool: Pool | null = null;

export function initializePool(config?: PoolConfig): Pool {
  if (_pool) return _pool;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString && !config?.connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  _pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });
  _pool.on('error', (err) => {
    console.error('Unexpected error on idle database client', err);
  });
  return _pool;
}

export function getPool(): Pool {
  if (!_pool) {
    throw new Error('Database pool not initialized. Call initializePool() first.');
  }
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Execute a parameterized query. Values are always passed separately —
 * string interpolation into the query text is prohibited.
 */
export async function query<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, values);
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on any
 * throw, and always releases the client. Used where several writes must be
 * atomic — e.g. approving a critical action and applying its effect together.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export type { Pool, PoolClient, PoolConfig, QueryResult } from 'pg';
