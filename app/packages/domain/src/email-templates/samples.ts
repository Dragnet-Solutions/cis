import type { EmailContent } from '../email-content';
import type { MergeFields, TemplateId } from './index';

/**
 * Sample merge values for every template — for the previews
 * (`pnpm --filter @cis/api email:preview`) and the template tests. Realistic
 * lengths, so the previews show how long names and links wrap.
 */

const PORTAL = 'https://dev-cis.idhub.ng';
const INVITE = `${PORTAL}/firm?invite=6f1c0b3e-2d4a-4b8e-9a51-7c2e1d9f0a34`;

const RAW_SAMPLES: Readonly<Record<TemplateId, MergeFields>> = {
  'F-01': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    code: INVITE,
    portal_link: INVITE,
    open_date: '3 November 2026',
    close_date: '15 December 2026',
    expires_on: '5 November 2026',
  },
  'F-02': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    code: INVITE,
    portal_link: INVITE,
    close_date: '15 December 2026',
  },
  'F-03': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    code: INVITE,
    portal_link: INVITE,
  },
  'F-04': {
    contact_name: 'Adaeze Okonkwo',
    contact_email: 'adaeze.okonkwo@meristem.example',
    firm: 'Meristem Stockbrokers Limited',
    portal_link: `${PORTAL}/firm`,
  },
  'F-05': {
    respondent_name: 'Tunde Bakare',
    coordinator_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    survey_name: 'S2 Compliance survey',
    survey_link: `${PORTAL}/survey?firmSeat=Zr2mE8qN4tY1uI0oP9aS7dF6gH5jK3lX`,
    close_date: '15 December 2026',
  },
  'F-06': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    portal_link: `${PORTAL}/firm`,
  },
  'F-07': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    portal_link: `${PORTAL}/firm`,
    close_date: '15 December 2026',
    surveys_done: 2,
  },
  'F-08': {
    respondent_name: 'Tunde Bakare',
    firm: 'Meristem Stockbrokers Limited',
    survey_name: 'S2 Compliance survey',
    submitted_at: '22 October 2026, 14:05 (Lagos time)',
    surveys_done: 2,
    still_to_come: 'Operations (S3)',
  },
  'F-09': {
    contact_name: 'Adaeze Okonkwo',
    firm: 'Meristem Stockbrokers Limited',
    portal_link: `${PORTAL}/firm`,
    close_date: '15 December 2026',
    investor_responses: 0,
  },
  'F-10': {
    requester_name: 'Chinedu Eze',
    firm: 'Cordros Securities Limited',
    request_ref: 'REQ-3F9A1C2B',
  },
  'F-11': {
    requester_name: 'Chinedu Eze',
    firm: 'Cordros Securities Limited',
    request_ref: 'REQ-3F9A1C2B',
  },
  'F-12': {
    requester_name: 'Chinedu Eze',
    firm: 'Cordros Securities Limited',
    request_ref: 'REQ-3F9A1C2B',
    decline_reason:
      'The firm is not on the CIS register of dealing members for this edition of the study.',
  },
  'F-13': {
    contact_name: 'Adaeze Okonkwo',
    edition: '2026',
    firm: 'Meristem Stockbrokers Limited',
    portal_link: `${PORTAL}/firm`,
  },
  'I-01': {
    contact_name: 'Dr Halima Yusuf',
    institution: 'Securities and Exchange Commission',
    respond_by: '30 November 2026',
    survey_link: `${PORTAL}/survey?resume=8c7d6e5f-4a3b-2c1d-0e9f-8a7b6c5d4e3f`,
  },
  'I-02': {
    contact_name: 'Dr Halima Yusuf',
    institution: 'Securities and Exchange Commission',
    respond_by: '30 November 2026',
    survey_link: `${PORTAL}/survey?resume=8c7d6e5f-4a3b-2c1d-0e9f-8a7b6c5d4e3f`,
  },
  'I-03': {
    contact_name: 'Dr Halima Yusuf',
    institution: 'Securities and Exchange Commission',
    submitted_at: '22 October 2026, 14:05 (Lagos time)',
  },
  'I-04': {
    contact_name: 'Mr Emeka Obi',
    institution: 'Lagos Commodities and Futures Exchange',
    submitted_at: '22 October 2026, 14:05 (Lagos time)',
  },
  'O-01': {
    person_name: 'Funmi Adeyemi',
    person_email: 'funmi.adeyemi@dragnet.example',
    added_by: 'Kola Ade',
    rights: 'See the study, Write to firms, regulators and participants, Request a critical action',
    set_password_url: `${PORTAL}/set-password?token=q8W2e4R6t8Y0u2I4o6P8a0S2d4F6g8H0j2K4l6Z8x0C`,
    link_expiry: '72 hours',
  },
  'O-02': {
    person_email: 'funmi.adeyemi@dragnet.example',
    reset_url: `${PORTAL}/set-password?token=q8W2e4R6t8Y0u2I4o6P8a0S2d4F6g8H0j2K4l6Z8x0C`,
    link_expiry: '24 hours',
  },
  'O-03': {
    action: 'Release the firm reports',
    requested_by: 'Funmi Adeyemi',
    requested_at: '22 October 2026, 14:05 (Lagos time)',
    approval_url: `${PORTAL}/?tab=firmreports`,
  },
  'O-04': {
    action: 'Release the firm reports',
    outcome: 'Declined',
    outcome_lower: 'declined',
    approver: 'Kola Ade',
    reason: 'Two firm reports have not been opened yet. Open them, then ask again.',
    decided_at: '22 October 2026, 16:40 (Lagos time)',
    ops_url: `${PORTAL}/?tab=firmreports`,
  },
  'P-01': { survey_link: `${PORTAL}/survey`, close_date: '15 December 2026' },
  'P-02': { recovery_url: `${PORTAL}/survey?resume=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7` },
  'P-03': {
    recovery_url: `${PORTAL}/survey?resume=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7`,
    stop_url: `${PORTAL}/survey?stop=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7`,
    progress_wording: 'You are about halfway through — around five minutes left.',
    close_date: '15 December 2026',
  },
  'P-04': {
    publish_date: 'after the survey closes on 15 December 2026 and the results are approved',
    optout_url: `${PORTAL}/survey?noReport=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7`,
    institution: 'Harbour Pension Fund',
  },
  'P-05': {
    report_url: `${PORTAL}/reports/industry?edition=0b6f6c1e-3a1f-4c55-9a1e-2f0d2b7c1a90`,
    institutional_url: `${PORTAL}/reports/institutional?edition=0b6f6c1e-3a1f-4c55-9a1e-2f0d2b7c1a90`,
    optout_url: `${PORTAL}/survey?noReport=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7`,
  },
};

/** Every sample, for the 2026 edition. */
export const SAMPLE_FIELDS: Readonly<Record<TemplateId, MergeFields>> = Object.fromEntries(
  Object.entries(RAW_SAMPLES).map(([id, f]) => [id, { edition: '2026', ...f }]),
) as unknown as Record<TemplateId, MergeFields>;

/** Notices without a template of their own, in the shared layout (BASE). */
export const SAMPLE_BASE_NOTICES: ReadonlyArray<{ kind: string; subject: string } & EmailContent> =
  [
    {
      kind: 'mail-test',
      subject: 'CIS × Dragnet — test email',
      audience: 'operator',
      label: 'Test',
      heading: 'Test email',
      paragraphs: [
        'This is a test email from the CIS × Dragnet study operations site.',
        'It was sent by Kola Ade to check that email is working. No action is needed.',
      ],
    },
    {
      kind: 'firm-coordinator-welcome',
      subject: "You have been added to Meristem Stockbrokers Limited's team",
      audience: 'firm',
      label: 'Your firm space',
      heading: "Welcome to Meristem Stockbrokers Limited's space",
      paragraphs: [
        'Dear Ngozi Chukwu,',
        'You have been added as a coordinator for Meristem Stockbrokers Limited in the CIS × Dragnet benchmark. From the firm portal you can follow your firm’s surveys and help its team.',
        'You sign in to the firm portal with this email address and a six-digit PIN.',
      ],
      action: { label: 'Open the firm portal', url: `${PORTAL}/firm` },
      footer: 'If you were not expecting this, reply to this email and the CIS team will help.',
    },
    {
      kind: 'survey-resume-link',
      subject: 'Your link back to the CIS × Dragnet survey',
      audience: 'investor',
      label: 'Your survey',
      heading: 'Your link back to the survey',
      paragraphs: [
        'Thank you for taking part in the CIS × Dragnet benchmark survey.',
        'Your answers save as you go. If you stop part-way, use the link below to come back to where you left off — on this device or another.',
      ],
      action: {
        label: 'Return to my survey',
        url: `${PORTAL}/survey?resume=b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7`,
      },
    },
  ];
