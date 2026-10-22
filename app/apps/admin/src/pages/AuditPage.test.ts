import { describe, it, expect } from 'vitest';
import { auditQueryString, compactJson, auditFilename, EMPTY_FILTER } from './AuditPage';

describe('Audit page helpers', () => {
  it('sends only the filters that are set, plus the cursor', () => {
    expect(auditQueryString(EMPTY_FILTER)).toBe('');
    expect(
      auditQueryString({ ...EMPTY_FILTER, from: '2026-10-01', action: 'edition.locked' }, 'abc'),
    ).toBe('from=2026-10-01&action=edition.locked&cursor=abc');
  });
  it('shows values as one short line', () => {
    expect(compactJson(null)).toBe('—');
    expect(compactJson({ a: 1 })).toBe('{"a":1}');
    expect(compactJson({ long: 'x'.repeat(200) }, 20)).toHaveLength(20);
  });
  it('names the export for its range', () => {
    expect(auditFilename({ ...EMPTY_FILTER, from: '2026-10-01', to: '2026-10-22' })).toBe(
      'audit-2026-10-01-2026-10-22.csv',
    );
    expect(auditFilename(EMPTY_FILTER)).toBe('audit-start-now.csv');
  });
});
