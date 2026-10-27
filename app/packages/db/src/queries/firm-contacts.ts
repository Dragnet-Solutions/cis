import { Pool, PoolClient } from 'pg';
import { query } from '../client';

/**
 * A firm's contact on file (NEW-2): who to invite, loaded with the firm
 * directory import. One per firm; a later import replaces the fields it gives.
 */
type Db = Pool | PoolClient;

export interface FirmContact {
  organizationId: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  registrationNumber: string | null;
  updatedAt: Date;
}

interface RawFirmContact {
  organization_id: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  registration_number: string | null;
  updated_at: Date;
}

const map = (r: RawFirmContact): FirmContact => ({
  organizationId: r.organization_id,
  contactName: r.contact_name,
  email: r.email,
  phone: r.phone,
  registrationNumber: r.registration_number,
  updatedAt: r.updated_at,
});

/** Set a firm's contact. A field given as null keeps what is on file. */
export async function upsertFirmContact(
  db: Db,
  input: {
    organizationId: string;
    contactName: string | null;
    email: string | null;
    phone: string | null;
    registrationNumber: string | null;
    updatedBy: string | null;
  },
): Promise<FirmContact> {
  const res = await query<RawFirmContact>(
    db as Pool,
    `INSERT INTO firm_contacts
       (organization_id, contact_name, email, phone, registration_number, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id) DO UPDATE SET
       contact_name        = COALESCE(EXCLUDED.contact_name, firm_contacts.contact_name),
       email               = COALESCE(EXCLUDED.email, firm_contacts.email),
       phone               = COALESCE(EXCLUDED.phone, firm_contacts.phone),
       registration_number = COALESCE(EXCLUDED.registration_number, firm_contacts.registration_number),
       updated_by          = EXCLUDED.updated_by,
       updated_at          = NOW()
     RETURNING *`,
    [
      input.organizationId,
      input.contactName,
      input.email,
      input.phone,
      input.registrationNumber,
      input.updatedBy,
    ],
  );
  return map(res.rows[0]!);
}

export async function getFirmContact(db: Db, organizationId: string): Promise<FirmContact | null> {
  const res = await query<RawFirmContact>(
    db as Pool,
    'SELECT * FROM firm_contacts WHERE organization_id = $1',
    [organizationId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}
