/**
 * Dev seed: populate a fresh database with the 2026 edition, the nine controlled
 * instruments (placeholder content), the seven DRG-OPS questions, and the RBAC
 * roles/permissions plus two operator users. Idempotent-guarded on the 2026
 * edition so re-running is safe.
 *
 *   pnpm --filter @cis/api seed
 */
import { initializePool, getPool, getEditionByLabel, closePool } from '@cis/db';
import { seedReferenceData } from '@cis/domain';

async function main(): Promise<void> {
  initializePool();
  const pool = getPool();

  const existing = await getEditionByLabel(pool, '2026');
  if (existing) {
    // eslint-disable-next-line no-console -- seed script user feedback
    console.log('2026 edition already exists — skipping seed.');
    await closePool();
    return;
  }

  const result = await seedReferenceData(pool);
  // eslint-disable-next-line no-console -- seed script user feedback
  console.log('Seeded reference data:', {
    editionId: result.editionId,
    users: ['adaeze.okoro@cis.example', 'segun.oyegbesan@dragnet.example'],
    password: 'ChangeMe!2026',
    instruments: Object.keys(result.instruments).join(', '),
  });
  await closePool();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
