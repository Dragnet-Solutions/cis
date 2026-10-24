/**
 * D-18 — no survey code (S1 … S5b, I-SEC … I-FMDQ) and no question ID
 * (S3-Q4, I-LCFE-Q1, ...) in anything a firm, an investor or an institution
 * reads: every email they receive, the survey names in them, and the messages
 * the respondent screens show. Operator emails (O-*) and screens keep codes.
 */
import { describe, it, expect } from 'vitest';
import { TEMPLATE_IDS, renderTemplate } from '../src/email-templates';
import { SAMPLE_FIELDS, SAMPLE_BASE_NOTICES } from '../src/email-templates/samples';
import { renderEmailHtml, renderEmailText } from '../src/email-content';
import { seatSurveyName } from '../src/email-fields';
import { ScopeClosedError } from '../src/journey-service';
import { ConsentRequiredError, ResponseScopeError } from '../src/response-service';

const BRAND = { logoUrl: 'https://cis.example/cis-logo.png', supportEmail: 'help@cis.example' };

/** A survey code, or a question ID built on one. */
const CODE_RE = /\b(S[1-4]|S5[ab]|I-(SEC|NGX|CSCS|LCFE|NASD|FMDQ|DEP))(-[A-Z]\d+)?\b/;

const SEATS = [
  { seatCode: 'S1', roleLabel: 'MD or Chief Executive' },
  { seatCode: 'S2', roleLabel: 'Compliance' },
  { seatCode: 'S3', roleLabel: 'Operations' },
];

const CLIENT_TEMPLATES = TEMPLATE_IDS.filter((id) => !id.startsWith('O-'));

describe('emails to firms, investors and institutions carry no code', () => {
  it.each(CLIENT_TEMPLATES)('%s: subject, HTML and text', (id) => {
    const r = renderTemplate(id, SAMPLE_FIELDS[id], { brand: BRAND });
    expect(r.subject).not.toMatch(CODE_RE);
    expect(r.html).not.toMatch(CODE_RE);
    expect(r.text).not.toMatch(CODE_RE);
  });

  it.each(
    SAMPLE_BASE_NOTICES.filter((n) => n.audience !== 'operator').map((n) => [n.kind, n] as const),
  )('notice %s', (_kind, n) => {
    expect(n.subject).not.toMatch(CODE_RE);
    expect(renderEmailHtml(n, { brand: BRAND })).not.toMatch(CODE_RE);
    expect(renderEmailText(n, { brand: BRAND })).not.toMatch(CODE_RE);
  });

  it('the samples themselves are code-free, so the check above means something', () => {
    for (const id of CLIENT_TEMPLATES) {
      expect(JSON.stringify(SAMPLE_FIELDS[id])).not.toMatch(CODE_RE);
    }
  });
});

describe('a firm seat’s survey is named by its role', () => {
  it.each(SEATS)('$seatCode', (seat) => {
    expect(seatSurveyName(seat)).toBe(`${seat.roleLabel} survey`);
    expect(seatSurveyName(seat)).not.toMatch(CODE_RE);
  });

  it('the assignment and confirmation subjects read as the client asked', () => {
    const s1 = seatSurveyName(SEATS[0]!);
    const firm = '[Test] 01 Alpha Securities';
    const assigned = renderTemplate(
      'F-05',
      { ...SAMPLE_FIELDS['F-05'], survey_name: s1, firm },
      { brand: BRAND },
    );
    expect(assigned.subject).toBe(
      'Please complete the MD or Chief Executive survey for [Test] 01 Alpha Securities',
    );
    const received = renderTemplate(
      'F-08',
      {
        ...SAMPLE_FIELDS['F-08'],
        survey_name: s1,
        firm,
        still_to_come: SEATS.slice(1).map(seatSurveyName).join(', '),
      },
      { brand: BRAND },
    );
    expect(received.subject).toBe('Received: MD or Chief Executive survey for ' + firm);
    expect(received.text).toContain('Still to come: Compliance survey, Operations survey.');
    expect(`${received.html}\n${received.text}`).not.toMatch(CODE_RE);
  });

  it('a code typed into a role label is dropped too', () => {
    expect(seatSurveyName({ seatCode: 'S2', roleLabel: 'S2 Compliance' })).toBe(
      'Compliance survey',
    );
  });
});

describe('messages a respondent can see carry no code', () => {
  it('an answer after a closing scope gate', () => {
    const err = new ScopeClosedError('I-LCFE-Q1');
    expect(err.message).toBe(
      'This question is not part of this survey: an earlier answer closed it.',
    );
    expect(err.message).not.toMatch(CODE_RE);
    // The ID stays on the error, for the server.
    expect(err.questionId).toBe('I-LCFE-Q1');
  });

  it.each(['S4', 'S5a', 'S5b'])('consent missing on %s', (code) => {
    const err = new ConsentRequiredError(code);
    expect(err.message).not.toMatch(CODE_RE);
    expect(err.instrumentCode).toBe(code);
  });

  it('a scope error keeps its IDs out of the message', () => {
    const err = new ResponseScopeError('This question is not part of this survey.', {
      questionId: 'S3-Q4',
      instrumentCode: 'S3',
    });
    expect(err.message).not.toMatch(CODE_RE);
    expect(err.details).toEqual({ questionId: 'S3-Q4', instrumentCode: 'S3' });
  });
});
