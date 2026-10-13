/**
 * The server stores a regulator's link as the API resume path; the person it
 * goes to needs the respondent survey URL the app actually resumes from.
 */
import { describe, it, expect } from 'vitest';
import { contactGaps, respondentLink } from './RegulatorsPage';

describe('respondentLink', () => {
  it('turns the stored API resume path into the survey URL', () => {
    expect(respondentLink('/journeys/resume/abc-123', 'https://study.example')).toBe(
      'https://study.example/survey?resume=abc-123',
    );
  });

  it('shows nothing when there is no link yet', () => {
    expect(respondentLink(null, 'https://study.example')).toBeNull();
    expect(respondentLink('not-a-resume-path', 'https://study.example')).toBeNull();
  });
});

// Regression (E2E 2026-10-09, D7): Save stayed disabled until Mobile was filled,
// with nothing saying the mobile was required or why Save was greyed out.
describe('contactGaps — the page says what a contact still needs', () => {
  const full = {
    who: 'Test Contact',
    role: 'Director',
    email: 'contact@example.test',
    phone: '0801 234 5678',
    how: 'Introduced by CIS',
  };

  it('names the mobile number when it is the only thing missing', () => {
    expect(contactGaps({ ...full, phone: '' })).toEqual(['a mobile number']);
    expect(contactGaps({ ...full, phone: '0801' })).toEqual(['a mobile number']);
  });

  it('is empty for a complete contact (the same rules the server applies)', () => {
    expect(contactGaps(full)).toEqual([]);
  });
});
