import { useEffect, useState } from 'react';
import { journeyApi } from './journeyClient';

/**
 * UX-X-002 — Help, privacy and about. This surface renders managed content
 * from Phase 15's UX-ADM-CNT-001; wording is not hard-coded here — every
 * paragraph below is whatever the admin wording surface currently publishes.
 */
export function HelpPrivacyAbout({ onBack }: { onBack: () => void }): JSX.Element {
  const [content, setContent] = useState<{
    privacyNotice: string;
    organisationDescriptions: { cis: string; dragnet: string };
    helpText: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void journeyApi.publicContent().then((c) => {
      if (!cancelled) setContent(c);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="journey">
      <h1 tabIndex={-1}>Help, privacy and about</h1>

      <div className="card">
        <h2>Privacy and confidentiality</h2>
        <p className="lede">{content?.privacyNotice || 'Managed privacy content renders here.'}</p>
      </div>

      <div className="row">
        <div className="card">
          <h2>About CIS</h2>
          <p className="lede">
            {content?.organisationDescriptions.cis || 'Managed organisation description.'}
          </p>
        </div>
        <div className="card">
          <h2>About Dragnet</h2>
          <p className="lede">
            {content?.organisationDescriptions.dragnet || 'Managed organisation description.'}
          </p>
        </div>
      </div>

      <div className="card">
        <h2>Need help?</h2>
        <p className="lede">
          {content?.helpText || 'Managed help text and approved support route.'}
        </p>
      </div>

      <button type="button" className="btn-2" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
