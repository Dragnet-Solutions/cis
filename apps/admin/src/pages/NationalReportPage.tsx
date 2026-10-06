import { useCallback, useEffect, useState } from 'react';
import {
  operatorIndustrySource as industrySource,
  operatorInstitutionalSource,
} from '../reports/source';
import { InstitutionalReport } from '../reports/InstitutionalReport';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AuthUser,
  type NationalApprovalPreconditions,
  type NationalReport,
  type NationalReportSection,
} from '../api/types';
import { isViewer, operatorName } from '../shared/operatorName';
import { IndustryReport } from '../reports/IndustryReport';

/**
 * UX-ADM-005 — National report review & approval, live-wired to the real
 * evaluator (`@cis/domain` national-report-service, via
 * `apps/api/src/routes/reporting.ts`): the ten fixed sections, each suppressed
 * or caveated by its OWN rule (never a single global test), named — not
 * counted — when withheld; approval blocked on four independently-checked
 * preconditions, including that the draft has actually been opened.
 *
 * One real, found gap this wiring surfaced rather than papered over: the
 * sentence-level adversarial review (`runChecker`/`runAdversaryHealth`/
 * `disposeFinding` in national-report-service.ts) has no route AND no real
 * generator anywhere in this codebase that produces draft sentences from
 * actual report data — nothing calls an LLM or template engine to turn scores
 * into prose. The previous "local state" mockup's `DRAFT` array was entirely
 * invented example text standing in for a capability that does not exist yet.
 * Rather than fabricate a fake wiring for it, this page shows that precondition
 * honestly: real, not fabricated. See the README for the full explanation —
 * this is a genuine open item for a product decision, not a UI bug.
 */

const SEGMENT_LABEL: Record<string, string> = {
  retail: 'Retail investors',
  local_institution: 'Local institutions',
  foreign_institution: 'Foreign institutions',
};

type SegmentInput = { meets: boolean; thin: boolean };

export function NationalReportPage({
  client,
  editionId,
  viewer,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
}): JSX.Element {
  const [reportId, setReportId] = useState<string | null | undefined>(undefined); // undefined = loading
  const [report, setReport] = useState<NationalReport | null>(null);
  const [sections, setSections] = useState<NationalReportSection[]>([]);
  const [pre, setPre] = useState<NationalApprovalPreconditions | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [authoritativeRunId, setAuthoritativeRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Starts NOT meeting until the live counts arrive — a default of "meets"
  // would let a click-through generate a below-floor segment as reportable.
  const [segInputs, setSegInputs] = useState<Record<string, SegmentInput>>({
    retail: { meets: false, thin: false },
    local_institution: { meets: false, thin: false },
    foreign_institution: { meets: false, thin: false },
  });
  const [counted, setCounted] = useState<Record<string, { counted: number; floor: number }>>({});
  const [regulatorsEngaged, setRegulatorsEngaged] = useState(0);
  const [approveReason, setApproveReason] = useState('');
  const [viewing, setViewing] = useState<false | 'industry' | 'institutional'>(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const runs = await client.getScoringRuns(editionId);
      setAuthoritativeRunId(runs.authoritative?.calculationRunId ?? null);

      const latest = await client.getLatestNationalReport(editionId);
      if (!latest.report) {
        setReportId(null);
        setReport(null);
        return;
      }
      setReportId(latest.report.id);
      const detail = await client.getNationalReport(latest.report.id);
      setReport(detail.report);
      setSections(detail.sections);
      setPre(detail.preconditions);
      setNames(detail.operatorNames ?? {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the national report');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    client
      .getSufficiency(editionId)
      .then(({ sufficiency }) => {
        setCounted(sufficiency);
        setSegInputs((prev) => {
          const next = { ...prev };
          for (const seg of Object.keys(prev)) {
            const s = sufficiency[seg];
            if (s) next[seg] = { ...prev[seg]!, meets: s.meets };
          }
          return next;
        });
      })
      .catch(() => {
        /* non-fatal — the boxes stay at "not met" and can be set by hand */
      });
  }, [client, editionId]);

  useEffect(() => {
    client
      .getRegulators(editionId)
      .then((r) => {
        const engaged = new Set(
          r.regulators.filter((x) => x.status === 'confirmed').map((x) => x.institutionId),
        );
        setRegulatorsEngaged(engaged.size);
      })
      .catch(() => {
        /* non-fatal — the generation form still works with a manually entered count */
      });
  }, [client, editionId]);

  const doRun = useCallback(
    async (fn: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (viewing === 'institutional') {
    return (
      <InstitutionalReport
        source={operatorInstitutionalSource(client, editionId)}
        onBack={() => setViewing(false)}
      />
    );
  }
  if (viewing) {
    return (
      <IndustryReport source={industrySource(client, editionId)} onBack={() => setViewing(false)} />
    );
  }

  if (reportId === undefined) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  // ── No report generated yet: the sufficiency-context entry step ──
  if (!report) {
    return (
      <main>
        <p className="eyebrow">Results · National report</p>
        <h1 tabIndex={-1}>National report</h1>
        {error && <div className="err">{error}</div>}
        {!authoritativeRunId ? (
          <div className="warnbox">
            <b>No signed-off scoring run exists yet.</b>
            <p style={{ margin: '6px 0 0' }}>
              A national report can only be generated from a signed-off run. Sign one off on Scoring
              first.
            </p>
          </div>
        ) : (
          <div className="note">
            <h3>No report has been generated for this edition yet</h3>
            <p>
              Generation evaluates each of the ten fixed sections against each segment’s
              sufficiency. The boxes below start from the current counts against each floor — mark a
              segment thin if it clears its floor but only just.
            </p>
            {(['retail', 'local_institution', 'foreign_institution'] as const).map((seg) => (
              <div key={seg} style={{ margin: '10px 0' }}>
                <b>{SEGMENT_LABEL[seg]}</b>
                {counted[seg] && (
                  <span className="muted">
                    {' '}
                    · {counted[seg]!.counted} of {counted[seg]!.floor} needed
                  </span>
                )}
                <div>
                  <label style={{ marginRight: 16 }}>
                    <input
                      type="checkbox"
                      checked={segInputs[seg]!.meets}
                      onChange={(e) =>
                        setSegInputs((prev) => ({
                          ...prev,
                          [seg]: { ...prev[seg]!, meets: e.target.checked },
                        }))
                      }
                    />{' '}
                    Meets its reportability floor
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={segInputs[seg]!.thin}
                      onChange={(e) =>
                        setSegInputs((prev) => ({
                          ...prev,
                          [seg]: { ...prev[seg]!, thin: e.target.checked },
                        }))
                      }
                    />{' '}
                    Thin (caveat, don't drop)
                  </label>
                </div>
              </div>
            ))}
            <div className="field" style={{ maxWidth: 200 }}>
              <label htmlFor="regEngaged">Regulators engaged (of 3)</label>
              <input
                id="regEngaged"
                type="number"
                min={0}
                max={3}
                value={regulatorsEngaged}
                onChange={(e) => setRegulatorsEngaged(parseInt(e.target.value, 10) || 0)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  doRun(() =>
                    client.generateNationalReport(editionId, authoritativeRunId, {
                      segments: segInputs,
                      regulatorsEngaged,
                    }),
                  )
                }
              >
                Generate the report
              </button>
            </div>
          </div>
        )}
      </main>
    );
  }

  if (report.status === 'approved') {
    return (
      <main>
        <p className="eyebrow">Approved for release</p>
        <h1 tabIndex={-1}>National report approved</h1>
        <div className="note">
          <p>
            Approved by {operatorName(names, report.approvedBy)} on{' '}
            {report.approvedAt ? new Date(report.approvedAt).toLocaleString() : '—'}. Firm reports
            may now be released.
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => setViewing('industry')}>
            Open the industry report
          </button>
          <button type="button" className="btn-2" onClick={() => setViewing('institutional')}>
            Institutional Perspectives
          </button>
        </div>
      </main>
    );
  }

  const suppressed = sections.filter((s) => s.disposition === 'suppressed');
  const caveated = sections.filter((s) => s.disposition === 'caveated');

  return (
    <main>
      <p className="eyebrow">Results · National report</p>
      <h1 tabIndex={-1}>National report</h1>
      <p className="lede">
        Ten sections. Approving without seeing which are suppressed and why is approving blind, so
        the sufficiency view is the surface.
      </p>
      <div className="actions">
        <button type="button" className="btn-2" onClick={() => setViewing('industry')}>
          Open the industry report
        </button>
        <button type="button" className="btn-2" onClick={() => setViewing('institutional')}>
          Institutional Perspectives
        </button>
      </div>

      {error && <div className="err">{error}</div>}

      <div className="statgrid">
        <div className="stat">
          <b>{sections.length - suppressed.length}</b>
          <span>Sections publishable</span>
        </div>
        <div className="stat">
          <b>{suppressed.length}</b>
          <span>Suppressed</span>
        </div>
        <div className="stat">
          <b>{caveated.length}</b>
          <span>Caveated (thin, shown)</span>
        </div>
      </div>

      <div className="tablewrap">
        <table className="ftbl">
          <thead>
            <tr>
              <th>Section</th>
              <th>Contract ID</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((s) => (
              <tr key={s.id}>
                <td>
                  {s.name ?? s.sectionId}
                  {s.reason ? (
                    <span style={{ display: 'block', fontSize: 12, color: '#6a6a6a' }}>
                      {s.reason}
                    </span>
                  ) : null}
                </td>
                <td>
                  <code style={{ fontSize: 12 }}>{s.sectionId}</code>
                </td>
                <td>
                  <span
                    className={`pill ${s.disposition === 'publishable' ? 'ok' : s.disposition === 'caveated' ? 'started' : 'bad'}`}
                  >
                    {s.disposition === 'publishable'
                      ? 'Publishable'
                      : s.disposition === 'caveated'
                        ? 'Caveated'
                        : 'Suppressed'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sentence-level adversarial review: no real generator exists yet (see
          the file header comment) — shown honestly, not fabricated. */}
      <section className="stage">
        <div className="stagehead">
          <h2>The draft, and what the checker found</h2>
          <span className="pill wait">Not yet available</span>
        </div>
        <div className="stagebody">
          <div className="warnbox">
            <b>Sentence-level review is not available yet.</b>
            <p style={{ margin: '6px 0 0' }}>
              Draft report sentences are not yet generated from the study data, so there is nothing
              for the adversarial checker to review. Until they are, the checker-health condition
              below cannot be met for this report.
            </p>
          </div>
        </div>
      </section>

      <section className="stage now">
        <div className="stagehead">
          <h2>The report itself</h2>
          <span className={`pill ${report.draftOpened ? 'ok' : 'started'}`}>
            {report.draftOpened ? 'Opened' : 'Not opened'}
          </span>
        </div>
        <div className="stagebody">
          <p>
            A consequential approval puts the thing being approved in front of the reviewer. Open
            the draft before the approve control activates.
          </p>
          <div className="actions">
            <button
              type="button"
              className={report.draftOpened ? 'btn-2' : 'btn'}
              disabled={busy}
              onClick={() => doRun(() => client.openNationalDraft(report.id))}
            >
              {report.draftOpened ? 'Open it again' : 'Open the draft report'}
            </button>
          </div>
        </div>
      </section>

      <section className="stage now">
        <div className="stagehead">
          <h2>Approving the report</h2>
          <span className="pill started">Not approved</span>
        </div>
        <div className="stagebody">
          {suppressed.length > 0 && (
            <div className="warnbox">
              <b>
                {suppressed.length} section{suppressed.length === 1 ? '' : 's'} will not appear.
              </b>
              <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                {suppressed.map((s) => (
                  <li key={s.id}>{s.name ?? s.sectionId}</li>
                ))}
              </ul>
            </div>
          )}
          {pre &&
            pre.reasons.map((r) => (
              <p className="err" key={r}>
                {r}
              </p>
            ))}
          {report.requestedBy ? (
            isViewer(report.requestedBy, viewer) ? (
              <p className="muted">
                You requested approval on{' '}
                {report.requestedAt ? new Date(report.requestedAt).toLocaleString() : '—'}. A maker
                can never approve their own request.
              </p>
            ) : (
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !pre?.ok}
                  onClick={() => doRun(() => client.approveNationalReport(report.id))}
                >
                  Approve for release
                </button>
              </div>
            )
          ) : (
            <>
              <div className="field">
                <label htmlFor="apReason">What you checked</label>
                <textarea
                  id="apReason"
                  value={approveReason}
                  onChange={(e) => setApproveReason(e.target.value)}
                />
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !pre?.ok || approveReason.trim().length < 10}
                  onClick={() =>
                    doRun(() => client.requestNationalApproval(report.id, approveReason.trim()))
                  }
                >
                  Request approval
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
