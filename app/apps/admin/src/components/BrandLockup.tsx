/**
 * The joint brand: the CIS crest and the Dragnet logo side by side at the same
 * height, split by a thin vertical rule (D-20). Used wherever people meet the
 * study — sign-in, entry and survey screens, the firm portal, the operator
 * console and the reports (and so their PDFs, which print those pages).
 *
 * Both images are served from public/. The Dragnet file is a placeholder until
 * the client supplies the real logo: replacing public/dragnet-logo.png is the
 * only change needed here (widths follow the image's own proportions).
 */
export const CIS_LOGO_SRC = '/cis-logo.png';
export const DRAGNET_LOGO_SRC = '/dragnet-logo.png';

export type BrandLockupSize = 'sm' | 'md' | 'lg';

export function BrandLockup({
  size = 'md',
  plate = false,
}: {
  /** sm: page headers; md: sign-in and entry screens; lg: report covers. */
  size?: BrandLockupSize;
  /** On a dark background: sit the logos on a white plate so they stay legible. */
  plate?: boolean;
}): JSX.Element {
  return (
    <span className={`brand-lockup brand-lockup-${size}${plate ? ' brand-lockup-plate' : ''}`}>
      <img src={CIS_LOGO_SRC} alt="Chartered Institute of Stockbrokers" />
      <span className="brand-lockup-rule" aria-hidden="true" />
      <img src={DRAGNET_LOGO_SRC} alt="Dragnet Solutions" />
    </span>
  );
}
