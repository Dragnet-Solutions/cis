/**
 * Phase 21 §4 — Channel vocabulary sweep (DEC-010 / DEC-012).
 *
 * DEC-012's own estate-reconciliation finding was that a WhatsApp migration
 * declared complete by searching markup ALONE missed seven survivors in
 * script/runtime copy — "a check that examines one layer of an artefact
 * proves nothing about the others." This test applies that lesson to THIS
 * codebase: scan source text (React components, domain services, DB seed
 * content) for "whatsapp" case-insensitively, not just type-level channel
 * unions. A hit here means a stray reference in user-facing copy or a stray
 * config default — exactly DEC-012's failure mode.
 *
 * A literal "WhatsApp" is allowed ONLY inside a comment that cites DEC-010 by
 * name (documenting that it was removed) — never in a string literal that
 * could reach a respondent, and never as a live code branch/config default.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [
  join(__dirname, '../../../apps/admin/src'),
  join(__dirname, '../../../apps/api/src'),
  join(__dirname, '../../../packages/domain/src'),
  join(__dirname, '../../../packages/db/src'),
  join(__dirname, '../../../packages/shared-types/src'),
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.json']);

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

describe('Channel vocabulary sweep — no WhatsApp survivor anywhere (DEC-010, DEC-012)', () => {
  it('finds no "whatsapp" occurrence outside a DEC-010-citing comment', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collectFiles(root)) {
        const text = readFileSync(file, 'utf-8');
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          if (!/whatsapp/i.test(line)) return;
          // Allowed: a comment line (//, /* */, JSX {/* */}, or a leading *
          // continuation) that also cites DEC-010 by name — the "we removed
          // this" record, not a live reference.
          const trimmed = line.trim();
          const isComment = /^(\/\/|\/\*|\*|#|\{\/\*)/.test(trimmed);
          const isCommentCitingDec010 = isComment && /DEC-010/.test(line);
          if (!isCommentCitingDec010) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
