/**
 * Firm invitation links for the coordinators' part. Claiming a firm's space
 * needs that firm's invitation link (`.../firm?invite=<token>`); operators
 * download them from the Firm team screen as CSV (`firm,email,link,expires`).
 * This file reads that CSV — or plain lines of links — into firm → token.
 *
 * A CSV row names its firm, so it is matched by name. A bare link names no
 * firm; the robot asks the public invitation lookup which firm it is for.
 */

export interface FirmInvites {
  /** Normalised firm name → invitation token. */
  byName: Map<string, string>;
  /** Tokens whose firm is not named in the file (looked up before claiming). */
  unnamed: string[];
}

/** Lower-case, single-spaced, without a spreadsheet's formula-guard apostrophe. */
export function normalizeFirmName(name: string): string {
  return name
    .replace(/^'(?=[=+\-@])/, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token in `...?invite=<token>`, or a bare token on its own. */
export function inviteTokenFromLink(text: string): string | null {
  const m = /[?&]invite=([^&\s#,"]+)/.exec(text);
  if (m?.[1]) return decodeURIComponent(m[1]);
  const bare = text.trim();
  return UUID_RE.test(bare) ? bare : null;
}

/** One CSV line → cells (double-quoted cells may hold commas and "" quotes). */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Reads the Firm team screen's CSV (header `firm,email,link,expires`, any
 * column order) or lines of links / bare tokens. Blank lines and lines
 * starting with # are ignored; a line without a link is skipped.
 */
export function parseFirmInvites(text: string): FirmInvites {
  const byName = new Map<string, string>();
  const unnamed: string[] = [];
  let header: { firm: number; link: number } | null = null;
  let first = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (first) {
      first = false;
      const cells = parseCsvLine(line).map((c) => c.toLowerCase());
      const link = cells.indexOf('link');
      if (link >= 0) {
        header = { firm: cells.indexOf('firm'), link };
        continue;
      }
    }
    if (header) {
      const cells = parseCsvLine(line);
      const token = inviteTokenFromLink(cells[header.link] ?? '');
      if (!token) continue;
      const firm = header.firm >= 0 ? (cells[header.firm] ?? '') : '';
      if (firm.trim()) byName.set(normalizeFirmName(firm), token);
      else if (!unnamed.includes(token)) unnamed.push(token);
      continue;
    }
    const token = inviteTokenFromLink(line) ?? inviteTokenFromLink(line.split(/\s+/).pop() ?? '');
    if (token && !unnamed.includes(token)) unnamed.push(token);
  }
  return { byName, unnamed };
}

/** Finds a firm's token: by the firm's id (resolved bare links) or by its name. */
export function inviteResolver(
  invites: FirmInvites,
  byId: ReadonlyMap<string, string>,
): (firm: { id: string; name: string }) => string | null {
  return (firm) => byId.get(firm.id) ?? invites.byName.get(normalizeFirmName(firm.name)) ?? null;
}
