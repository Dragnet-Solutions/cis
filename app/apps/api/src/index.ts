import { initializePool } from '@cis/db';
import { buildServer } from './server';

async function main() {
  initializePool();
  const app = await buildServer();

  const host = process.env['HOST'] ?? '0.0.0.0';
  const port = Number(process.env['PORT'] ?? 3000);

  try {
    await app.listen({ host, port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
