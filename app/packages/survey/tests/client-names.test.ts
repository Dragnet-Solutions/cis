/**
 * D-18 — survey codes and question IDs never reach a firm, an investor or an
 * institution: names lose their code, messages lose codes and question IDs.
 */
import { describe, it, expect } from 'vitest';
import { clientMessage, clientSurveyName, containsInternalCode } from '../src';

const CODES = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5a',
  'S5b',
  'I-SEC',
  'I-NGX',
  'I-CSCS',
  'I-LCFE',
  'I-NASD',
  'I-FMDQ',
];

describe('containsInternalCode', () => {
  it.each(CODES)('finds the code %s and its question IDs', (code) => {
    expect(containsInternalCode(`About the ${code} survey`)).toBe(true);
    expect(containsInternalCode(`${code}-Q4 needs an answer`)).toBe(true);
    expect(containsInternalCode(`see ${code}-A1`)).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    for (const text of [
      'MD or Chief Executive survey',
      'Question 4 of 12',
      'Q0 closed the survey',
      'WI-FI and S10 are not codes',
      'Securities and Exchange Commission',
    ]) {
      expect(containsInternalCode(text)).toBe(false);
    }
  });
});

describe('clientSurveyName', () => {
  it('drops the code in front of the name', () => {
    expect(clientSurveyName('S1', 'S1 MD or Chief Executive survey')).toBe(
      'MD or Chief Executive survey',
    );
    expect(clientSurveyName('S2', 'S2 — Compliance survey')).toBe('Compliance survey');
    expect(clientSurveyName('S5a', 'S5a: Local institutional investor survey')).toBe(
      'Local institutional investor survey',
    );
    expect(clientSurveyName('I-LCFE', 'I-LCFE Lagos Commodities and Futures Exchange')).toBe(
      'Lagos Commodities and Futures Exchange',
    );
  });

  it('drops a code in brackets after the name', () => {
    expect(clientSurveyName('S3', 'Operations survey (S3)')).toBe('Operations survey');
  });

  it('drops a code that is not the survey’s own, and leaves a code-free name as it is', () => {
    expect(clientSurveyName(null, 'S4 Retail investor survey')).toBe('Retail investor survey');
    expect(clientSurveyName('S1', 'MD or Chief Executive survey')).toBe(
      'MD or Chief Executive survey',
    );
    expect(clientSurveyName('S4', 'Retail investor survey')).toBe('Retail investor survey');
  });

  it('never leaves a code behind, for every survey', () => {
    for (const code of CODES) {
      expect(containsInternalCode(clientSurveyName(code, `${code} Example survey`))).toBe(false);
    }
  });
});

describe('clientMessage', () => {
  it('turns a question ID into "this question"', () => {
    expect(
      clientMessage('I-LCFE-Q1 is not part of this survey: an earlier answer closed it.'),
    ).toBe('This question is not part of this survey: an earlier answer closed it.');
    expect(clientMessage('Please answer S3-Q4 first')).toBe('Please answer this question first');
  });

  it('drops survey codes', () => {
    expect(
      clientMessage('Consent has not been accepted for S5a; the survey cannot be submitted'),
    ).toBe('Consent has not been accepted; the survey cannot be submitted');
    expect(clientMessage('Still to come: Compliance (S2), Operations (S3).')).toBe(
      'Still to come: Compliance, Operations.',
    );
    expect(clientMessage('Invalid enum value. Expected S1 | S2 | S3')).not.toMatch(/S[123]/);
  });

  it('leaves a code-free message unchanged', () => {
    const m = 'This survey has already been submitted. Your answers are saved.';
    expect(clientMessage(m)).toBe(m);
  });
});
