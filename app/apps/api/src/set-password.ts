/**
 * Set an operator's sign-in password, directly in the database.
 *
 *   pnpm --filter @cis/api set-password <email>
 *
 * The password is typed at a hidden prompt (or piped on stdin) and stored only
 * as its argon2 hash in `users.password_hash` — it is never written to a file,
 * an env var or a log. Uses DATABASE_URL, so point that at the database to set.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { getPool, initializePool, closePool } from '@cis/db';
import { hashPassword } from '@cis/auth';

const MIN_LENGTH = 12;

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let piped = '';
    for await (const chunk of process.stdin) piped += String(chunk);
    return piped.replace(/\r?\n$/, '');
  }
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) throw new Error('Usage: pnpm --filter @cis/api set-password <email>');
  initializePool();
  const pool = getPool();
  const found = await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  if (found.rowCount === 0) throw new Error(`No user with email ${email} in this database.`);

  const password = await readPassword(`New password for ${email}: `);
  if (password.length < MIN_LENGTH) {
    throw new Error(`The password must be at least ${MIN_LENGTH} characters.`);
  }
  if (process.stdin.isTTY && (await readPassword('Again: ')) !== password) {
    throw new Error('The two entries did not match — nothing was changed.');
  }
  await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE email = $2', [
    await hashPassword(password),
    email,
  ]);
  // eslint-disable-next-line no-console -- script result
  console.log(`Password set for ${email}.`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void closePool());
