import { Rng } from './rng';

/**
 * Obviously fake identities. Every email ends in `@test.example` (a reserved
 * domain that can never deliver), every surname is a placeholder word, every
 * phone number is a `+234 000 555 …` number no network issues, and every
 * institution name starts with "[Test]".
 */

export const TEST_EMAIL_DOMAIN = 'test.example';

const FIRST = [
  'Ada',
  'Bola',
  'Chidi',
  'Dayo',
  'Emeka',
  'Funmi',
  'Gbenga',
  'Halima',
  'Ife',
  'Jide',
  'Kemi',
  'Lola',
  'Musa',
  'Ngozi',
  'Obi',
  'Peju',
  'Quadri',
  'Remi',
  'Sade',
  'Tunde',
  'Uche',
  'Wale',
  'Yemi',
  'Zainab',
];
const LAST = [
  'Testperson',
  'Example',
  'Sample',
  'Placeholder',
  'Dummy',
  'Mockwell',
  'Fakeworth',
  'Specimen',
  'Testwell',
  'Notreal',
];

export interface FakePerson {
  name: string;
  email: string;
  phone: string;
}

function slugPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

/** A fake person; `tag` makes the email unique (e.g. "r0042", "f12.s2"). */
export function fakePerson(rng: Rng, tag: string): FakePerson {
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  const digits = String(rng.int(0, 9999)).padStart(4, '0');
  return {
    name: `${first} ${last}`,
    email: `${slugPart(first)}.${slugPart(last)}.${slugPart(tag)}@${TEST_EMAIL_DOMAIN}`,
    phone: `+234 000 555 ${digits}`,
  };
}

const INST_ADJ = ['Harbour', 'Northbridge', 'Lagoon', 'Meridian', 'Savanna', 'Keystone', 'Atlas'];
const LOCAL_TYPES = [
  'Pension Fund Administrator',
  'Asset Management',
  'Insurance',
  'Unit Trust',
  'Treasury Desk',
];
const FOREIGN_TYPES = [
  'Capital Partners (UK)',
  'Frontier Fund (US)',
  'Emerging Markets Equity (SA)',
  'Global Investors (DE)',
  'Africa Opportunities (KE)',
];

/** A unique, obviously fake institution name for the n-th planned institution. */
export function fakeInstitution(rng: Rng, segment: 'local' | 'foreign', n: number): string {
  const types = segment === 'local' ? LOCAL_TYPES : FOREIGN_TYPES;
  const label = segment === 'local' ? 'L' : 'F';
  return `[Test] ${rng.pick(INST_ADJ)} ${rng.pick(types)} ${label}${String(n + 1).padStart(2, '0')}`;
}
