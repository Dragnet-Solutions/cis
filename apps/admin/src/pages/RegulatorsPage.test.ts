/**
 * The server stores a regulator's link as the API resume path; the person it
 * goes to needs the respondent survey URL the app actually resumes from.
 */
import { describe, it, expect } from 'vitest';
import { respondentLink } from './RegulatorsPage';

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
