import { Pool } from 'pg';
import { listOrganizations, createOrganization, withTransaction } from '@cis/db';
import { requirePermission, type RbacContext } from '@cis/auth';
import { writeAudit } from '@cis/audit';
import { FirmTeamError } from './firm-team-service';
import { EDITION_MANAGE_PERMISSION, type ActorContext } from './edition-service';

/**
 * The firm directory import — loading the participating stockbroking firms
 * before launch from a CSV, instead of inserting them by hand in the database.
 *
 * The file has a header row. `name` is required; `slug` (the firm's short,
 * permanent identifier) is optional and is derived from the name when absent.
 * Every import is previewed first (a dry run that writes nothing); the real
 * import writes the same plan in one transaction.
 *
 *   - A row whose name or slug is already in the directory, or repeats an
 *     earlier row of the file, is a DUPLICATE: skipped and listed, never added
 *     twice. Uploading the same file again adds nothing.
 *   - A row that cannot be read (no name, a malformed slug, a name too long) is
 *     an ERROR. Any error stops the whole import, so a file is never half-loaded.
 *
 * Changing the directory is part of the setup, so both the preview and the
 * import need the "Change the setup" right; each added firm is audited.
 */

export const MAX_IMPORT_ROWS = 2000;
const MAX_NAME_LENGTH = 200;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface FirmImportRow {
  /** The line of the file the row came from (the header is line 1). */
  line: number;
  name: string;
  slug: string;
}

export interface FirmImportPlan {
  /** Data rows read from the file (the header excluded, blank lines ignored). */
  totalRows: number;
  toAdd: FirmImportRow[];
  duplicates: Array<FirmImportRow & { reason: string }>;
  errors: Array<{ line: number; message: string }>;
}

export interface FirmImportResult extends FirmImportPlan {
  dryRun: boolean;
  /** Number of firms actually added (always 0 on a dry run). */
  added: number;
}

/** Split CSV text into rows of fields. Handles quoted fields, doubled quotes,
 *  commas and line breaks inside quotes, CRLF line endings and a leading BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A firm's slug from its name: lower case, letters and digits joined by single
 *  hyphens ("[Test] 02 Beta Brokerage" → "test-02-beta-brokerage"). */
export function slugifyFirmName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Names compare without regard to case, spacing or punctuation. */
function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Read the file and work out what an import would do — writes nothing. */
export async function planFirmImport(pool: Pool, csv: string): Promise<FirmImportPlan> {
  const rows = parseCsv(csv);
  const plan: FirmImportPlan = { totalRows: 0, toAdd: [], duplicates: [], errors: [] };

  const header = rows[0]?.map((h) => h.trim().toLowerCase()) ?? [];
  const nameCol = header.indexOf('name');
  const slugCol = header.indexOf('slug');
  if (nameCol === -1) {
    plan.errors.push({
      line: 1,
      message: 'The first line must be a header with a "name" column (and optionally "slug").',
    });
    return plan;
  }

  const existing = await listOrganizations(pool);
  const takenNames = new Map(existing.map((o) => [nameKey(o.displayName), o.displayName]));
  const takenSlugs = new Map(existing.map((o) => [o.slug, o.displayName]));
  const fileNames = new Map<string, number>();
  const fileSlugs = new Map<string, number>();

  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]!;
    const line = i + 1;
    if (cells.every((c) => c.trim() === '')) continue; // blank line
    plan.totalRows++;
    if (plan.totalRows > MAX_IMPORT_ROWS) {
      plan.errors.push({
        line,
        message: `A file can hold at most ${MAX_IMPORT_ROWS} firms. Split it and import each part.`,
      });
      break;
    }

    const name = (cells[nameCol] ?? '').trim().replace(/\s+/g, ' ');
    const givenSlug = slugCol === -1 ? '' : (cells[slugCol] ?? '').trim().toLowerCase();
    if (!name) {
      plan.errors.push({ line, message: 'The firm has no name.' });
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      plan.errors.push({
        line,
        message: `The name is longer than ${MAX_NAME_LENGTH} characters.`,
      });
      continue;
    }
    const slug = givenSlug || slugifyFirmName(name);
    if (!SLUG_PATTERN.test(slug)) {
      plan.errors.push({
        line,
        message: givenSlug
          ? `"${givenSlug}" is not a usable slug — use lower-case letters, digits and single hyphens.`
          : 'A slug cannot be made from this name. Add a "slug" column for it.',
      });
      continue;
    }

    const row: FirmImportRow = { line, name, slug };
    const key = nameKey(name);
    const reason = takenNames.has(key)
      ? `Already in the directory as "${takenNames.get(key)}".`
      : takenSlugs.has(slug)
        ? `The slug "${slug}" is already used by "${takenSlugs.get(slug)}".`
        : fileNames.has(key)
          ? `Repeats line ${fileNames.get(key)}.`
          : fileSlugs.has(slug)
            ? `The slug "${slug}" repeats line ${fileSlugs.get(slug)}.`
            : null;
    if (reason) {
      plan.duplicates.push({ ...row, reason });
      continue;
    }
    fileNames.set(key, line);
    fileSlugs.set(slug, line);
    plan.toAdd.push(row);
  }
  return plan;
}

/**
 * Preview (`dryRun`) or carry out an import of the firm directory. A real
 * import refuses outright if the file has any error, adds every new firm in one
 * transaction, and audits each one.
 */
export async function importFirmDirectory(
  pool: Pool,
  rbac: RbacContext,
  csv: string,
  options: { dryRun: boolean },
  ctx: ActorContext = {},
): Promise<FirmImportResult> {
  requirePermission(rbac, EDITION_MANAGE_PERMISSION);
  const plan = await planFirmImport(pool, csv);
  if (options.dryRun) return { ...plan, dryRun: true, added: 0 };

  if (plan.errors.length > 0) {
    throw new FirmTeamError(
      `The file has ${plan.errors.length} ${plan.errors.length === 1 ? 'line' : 'lines'} that cannot be read. Nothing was imported — correct the file and preview it again.`,
      'IMPORT_INVALID',
    );
  }

  try {
    await withTransaction(pool, async (client) => {
      const c = client as unknown as Pool;
      for (const row of plan.toAdd) {
        const org = await createOrganization(c, {
          slug: row.slug,
          displayName: row.name,
          orgType: 'firm',
        });
        await writeAudit(c, {
          actorId: rbac.userId,
          actionType: 'firm_directory.firm_added',
          entityType: 'organization',
          entityId: org.id,
          newValue: { displayName: org.displayName, slug: org.slug, source: 'csv_import' },
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
        });
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      // Someone added one of these firms between the preview and the import.
      throw new FirmTeamError(
        'The directory changed while you were importing. Nothing was imported — preview the file again.',
        'IMPORT_CONFLICT',
      );
    }
    throw err;
  }

  return { ...plan, dryRun: false, added: plan.toAdd.length };
}
