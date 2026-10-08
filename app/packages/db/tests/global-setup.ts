import { runMigrations, closeTestPool } from './setup';

export async function setup() {
  await runMigrations();
}

export async function teardown() {
  await closeTestPool();
}
