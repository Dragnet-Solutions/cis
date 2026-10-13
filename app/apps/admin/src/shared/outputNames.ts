/**
 * Plain names for the internal ids of promised report outputs, report sections
 * and participation segments, so an operator screen never shows a contract id
 * such as "FIRM_REPORT.FRM_04" or "SEI_GAP". One shared map: any screen that
 * lists outputs or sections reads its names from here.
 */

/** National (public) report sections, PUB_01 to PUB_10. */
const NATIONAL_SECTION_NAMES: Record<string, string> = {
  PUB_01: 'The five headline scores',
  PUB_02: 'Investor experience and confidence by investor segment',
  PUB_03: 'Top operational frictions',
  PUB_04: 'Top investor frustrations',
  PUB_05: 'Maturity heatmap by firm tier',
  PUB_06: 'Confidence drivers, barriers and participation',
  PUB_07: 'Local and foreign institutional investors compared',
  PUB_08: 'Brokers against banks and fintechs',
  PUB_09: 'The service excellence gap',
  PUB_10: 'Institutional Perspectives',
};

/** Participating-firm report parts, FRM_01 to FRM_04. FRM_01–03 are the
 *  guaranteed combined report; FRM_04 is the gated retail-client cut. */
const FIRM_REPORT_PART_NAMES: Record<string, string> = {
  FRM_01: 'Participating-firm report, part 1',
  FRM_02: 'Participating-firm report, part 2',
  FRM_03: 'Participating-firm report, part 3',
  FRM_04: 'Participating-firm report: retail client breakdown',
};

/** The monitoring outputs on the Responses page's dependency table. */
const OUTPUT_NAMES: Record<string, string> = {
  OMI: 'Operational maturity score',
  DMI: 'Digital maturity score',
  IEI_ICI_HEADLINE: 'Investor experience and confidence scores',
  IEI_ICI_BY_SEGMENT: 'Investor experience and confidence by investor segment',
  SEI_GAP: 'Service excellence gap',
  LOCAL_VS_FOREIGN: 'Local and foreign institutional investors compared',
  FIRM_TIER_HEATMAP: 'Maturity heatmap by firm tier',
  PARTICIPATING_FIRM_REPORT: 'Participating-firm report (combined)',
  PARTICIPATING_FIRM_REPORT_CATEGORY_CUTS: 'Participating-firm report: client breakdowns',
  TOP_INVESTOR_FRUSTRATIONS: 'Top investor frustrations',
  INSTITUTIONAL_PERSPECTIVES: 'Institutional Perspectives',
  PUBLIC_REPORT: 'National report',
  FIRM_REPORT: 'Participating-firm report',
};

const SEGMENT_NAMES: Record<string, string> = {
  firm: 'participating firms',
  retail: 'retail investors',
  local_institution: 'local institutions',
  foreign_institution: 'foreign institutions',
  regulators: 'regulators',
};

/** "PUB_10" or "PUB_10_INSTITUTIONAL_PERSPECTIVES" → its section/part code. */
function partCode(id: string): string | null {
  const m = /^(PUB|FRM)_(\d{2})/.exec(id);
  return m ? `${m[1]}_${m[2]}` : null;
}

/**
 * The plain name for an output, section or report-part id. Handles bare ids
 * ("SEI_GAP"), section ids ("PUB_10_INSTITUTIONAL_PERSPECTIVES") and qualified
 * ids ("PUBLIC_REPORT.PUB_10", "FIRM_REPORT.FRM_04"). An id with no known name
 * is turned into words rather than shown raw.
 */
export function outputName(id: string): string {
  if (OUTPUT_NAMES[id]) return OUTPUT_NAMES[id];
  const last = id.includes('.') ? id.slice(id.lastIndexOf('.') + 1) : id;
  const code = partCode(last);
  if (code && NATIONAL_SECTION_NAMES[code]) return NATIONAL_SECTION_NAMES[code];
  if (code && FIRM_REPORT_PART_NAMES[code]) return FIRM_REPORT_PART_NAMES[code];
  if (OUTPUT_NAMES[last]) return OUTPUT_NAMES[last];
  const words = last
    .replace(/^(PUB|FRM)_\d{2}_?/, '')
    .replace(/[_.]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** The plain name for a participation segment ("local_institution" → "local institutions"). */
export function segmentName(segment: string): string {
  return SEGMENT_NAMES[segment] ?? segment.replace(/_/g, ' ');
}
