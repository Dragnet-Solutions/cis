import { closePool, initializePool } from '@cis/db';
import { buildServer } from './server';

async function main() {
  initializePool();
  const app = await buildServer();

  const host = process.env['HOST'] ?? '0.0.0.0';
  const port = Number(process.env['PORT'] ?? 3000);

  // On SIGTERM (a rollout or scale-down) stop accepting connections, let
  // in-flight requests finish, then release the database pool.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await closePool();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    await app.listen({ host, port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
