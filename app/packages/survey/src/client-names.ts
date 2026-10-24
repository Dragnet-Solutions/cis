/**
 * D-18 — the internal survey codes (S1, S2, S3, S4, S5a, S5b, I-SEC, I-NGX,
 * I-CSCS, I-LCFE, I-NASD, I-FMDQ, ...) and question IDs (S3-Q4, I-LCFE-Q1, ...)
 * are the study team's shorthand. Operator screens keep them; nothing a firm,
 * an investor or an institution sees may carry one — not an email, a survey
 * screen, a progress message or an error.
 *
 * Shared by the API (emails, error messages) and the respondent screens, so
 * both sides draw the line in the same place.
 */

/** One survey code: the firm (S1–S3) and investor (S4, S5a, S5b) surveys and
 *  every institutional instrument (I- plus its short name). */
const CODE = String.raw`(?:S[1-4]|S5[ab]|I-[A-Z]{2,})`;
/** A question ID: a survey code, then the item (Q1, A1, P1, ...). */
const QUESTION_ID = String.raw`${CODE}-[A-Z]\d+`;

const QUESTION_ID_RE = new RegExp(String.raw`\b${QUESTION_ID}\b`, 'g');
const ANY_CODE_RE = new RegExp(String.raw`\b${CODE}(?:-[A-Z]\d+)?\b`);

/** Whether text carries a survey code or a question ID. */
export function containsInternalCode(text: string): boolean {
  return ANY_CODE_RE.test(text);
}

/**
 * A survey's name as firms, investors and institutions read it: the name
 * without the code in front ("S1 MD or Chief Executive survey" → "MD or
 * Chief Executive survey"), or after it in brackets ("Compliance (S2)").
 * Register names are already code-free; this keeps a code typed into a name
 * from reaching a client.
 */
export function clientSurveyName(code: string | null | undefined, name: string): string {
  const own = code ? code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null;
  const token = own ? `(?:${own}|${CODE})` : CODE;
  const cleaned = name
    .replace(new RegExp(String.raw`^\s*${token}\b\s*[-–—:·|.]?\s*`), '')
    .replace(new RegExp(String.raw`\s*[([]\s*${token}\s*[)\]]\s*$`), '')
    .trim();
  return cleaned || 'survey';
}

/**
 * A message fit to show a respondent or a firm: question IDs read "this
 * question", and survey codes are dropped. The API's own respondent-facing
 * messages are written code-free; this is the screen's last guard for any
 * message that is not (a validation error, an older server).
 */
export function clientMessage(message: string): string {
  const out = message
    .replace(QUESTION_ID_RE, 'this question')
    .replace(new RegExp(String.raw`\s*[([]\s*${CODE}\s*[)\]]`, 'g'), '')
    .replace(new RegExp(String.raw`\s+(?:for|of|in)\s+${CODE}\b`, 'g'), '')
    .replace(new RegExp(String.raw`\b${CODE}\b\s*`, 'g'), '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}
