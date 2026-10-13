/**
 * Regression (E2E 2026-10-09, D10): the Responses page's report-dependency
 * table showed raw contract ids (FIRM_REPORT.FRM_04, PUBLIC_REPORT.PUB_10,
 * SEI_GAP, PUB_01_HEADLINE_INDICES) instead of names.
 */
import { describe, it, expect } from 'vitest';
import { outputName, segmentName } from './outputNames';
import { plural } from './plural';

const RAW_ID = /[A-Z]{2,}_[A-Z0-9_]+|\.[A-Z]/;

describe('outputName — no contract id reaches an operator', () => {
  it('names every id the dependency table and report sections use', () => {
    for (const id of [
      'OMI',
      'DMI',
      'IEI_ICI_HEADLINE',
      'IEI_ICI_BY_SEGMENT',
      'SEI_GAP',
      'LOCAL_VS_FOREIGN',
      'FIRM_TIER_HEATMAP',
      'PARTICIPATING_FIRM_REPORT',
      'PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS',
      'TOP_INVESTOR_FRUSTRATIONS',
      'INSTITUTIONAL_PERSPECTIVES',
      'PUBLIC_REPORT',
      'PUBLIC_REPORT.PUB_10',
      'FIRM_REPORT.FRM_04',
      'PUB_01_HEADLINE_INDICES',
      'PUB_10_INSTITUTIONAL_PERSPECTIVES',
    ]) {
      expect(outputName(id), id).not.toMatch(RAW_ID);
    }
    expect(outputName('PUBLIC_REPORT.PUB_10')).toBe('Institutional Perspectives');
    expect(outputName('SEI_GAP')).toBe('Service excellence gap');
  });

  it('turns an unknown id into words rather than showing it raw', () => {
    expect(outputName('SOME_NEW_OUTPUT')).toBe('Some new output');
  });

  it('names segments in words', () => {
    expect(segmentName('local_institution')).toBe('local institutions');
    expect(segmentName('regulators')).toBe('regulators');
  });
});

describe('plural — D20/D27 grammar', () => {
  it('uses the singular only for exactly one', () => {
    expect(plural(1, 'firm')).toBe('1 firm');
    expect(plural(0, 'firm')).toBe('0 firms');
    expect(plural(2, 'index', 'indices')).toBe('2 indices');
    expect(plural(1, 'person', 'people')).toBe('1 person');
    expect(plural(3, 'person', 'people')).toBe('3 people');
  });
});
