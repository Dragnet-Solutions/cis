/**
 * BUG-06: every CSV the platform writes neutralises cells a spreadsheet would
 * run as a formula (= + - @, tab, carriage return), and quotes as needed.
 */
import { describe, it, expect } from 'vitest';
import { csvCell, csvRow, neutraliseFormula } from '../src';

describe('CSV cells are formula-safe (BUG-06)', () => {
  it.each([
    ['=HYPERLINK("http://x","click")', `"'=HYPERLINK(""http://x"",""click"")"`],
    ['+2+3', "'+2+3"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\r=1+1', `"'\r=1+1"`],
  ])('%j is written as plain text', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves ordinary values alone, and quotes commas, quotes and line breaks', () => {
    expect(csvCell('Cordros Securities')).toBe('Cordros Securities');
    expect(csvCell('Smith, Jones & Co')).toBe('"Smith, Jones & Co"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('writes numbers as numbers, negative ones included', () => {
    expect(csvCell(-4)).toBe('-4');
    expect(csvRow(['=bad', 12, null, 'ok'])).toBe("'=bad,12,,ok");
  });

  it('neutraliseFormula only prefixes risky starts', () => {
    expect(neutraliseFormula('=1')).toBe("'=1");
    expect(neutraliseFormula('a=1')).toBe('a=1');
  });
});
