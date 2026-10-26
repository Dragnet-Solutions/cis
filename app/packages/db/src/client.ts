import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

let _pool: Pool | null = null;

const envInt = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

/**
 * True when a query could not get a database connection in time: every pooled
 * connection was busy for the whole wait (a burst of requests), or the
 * database did not answer the connect. The API reports it as "busy, try
 * again" (503), not as an internal error.
 */
export function isPoolBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return (
    message === 'timeout exceeded when trying to connect' ||
    message.startsWith('Connection terminated due to connection timeout')
  );
}

export function initializePool(config?: PoolConfig): Pool {
  if (_pool) return _pool;
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString && !config?.connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  _pool = new Pool({
    connectionString,
    max: envInt('DB_POOL_MAX', 20),
    idleTimeoutMillis: 30_000,
    // How long a request waits for a free connection. A burst (81 invitations
    // resent at once against the remote database) queues well past 5 s, so a
    // short wait turned an ordinary queue into failures (E02).
    connectionTimeoutMillis: envInt('DB_POOL_WAIT_MS', 30_000),
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
