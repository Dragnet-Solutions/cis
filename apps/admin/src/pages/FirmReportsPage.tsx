import { useCallback, useEffect, useState } from 'react';
import { operatorFirmSource as firmSource } from '../reports/source';
import { FirmReport as FirmReportDocument } from '../reports/FirmReport';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type FirmReport,
  type FirmSummary,
  type ReleaseFirmReportsResult,
} from '../api/types';

/**
 * UX-ADM-006 — Firm report generation & release, live-wired to the real
 * evaluator (`@cis/domain` firm-report-service, via
 * `apps/api/src/routes/reporting.ts`): the guarantee (every participating firm
 * gets its combined report) is a separate rule from the retail-cut
 * sufficiency gate; release is ATOMIC PER REPORT — a failed report is HELD,
 * not excluded, and holds no other firm back; release is blocked until the
 * national report is approved.
 *
 * A held/failed report can be retried from here — never a released one; a
 * correction to a released report is a new version, not an edit to it (the DB
 * itself refuses any edit to a released row).
 */

const CUT_LABEL: Record<string, string> = {
  unlocked: 'Unlocked',
  directional: 'Directional only',
  none: 'Not shown',
};

export function FirmReportsPage({
  client,
  editionId,
}: {
  client: AdminClient;
  editionId: string;
}): JSX.Element {
  const [reports, setReports] = useState<FirmReport[] | null>(null);
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [authoritativeRunId, setAuthoritativeRunId] = useState<string | null>(null);
  const [nationalApproved, setNationalApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [releaseResult, setReleaseResult] = useState<ReleaseFirmReportsResult | null>(null);
  const [notices, setNotices] = useState<
    Record<string, { sent: number; logged: number; failed: number; queued: number }>
  >({});
  const [generationAttempted, setGenerationAttempted] = useState(false);
  const [viewingFirm, setViewingFirm] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [reportsRes, firmsRes, runsRes, latestNational] = await Promise.all([
        client.getFirmReports(editionId),
        client.listFirms(),
        client.getScoringRuns(editionId),
        client.getLatestNationalReport(editionId),
      ]);
      setReports(reportsRes.reports);
      setNotices(reportsRes.notices ?? {});
      setFirms(firmsRes);
      setAuthoritativeRunId(runsRes.authoritative?.calculationRunId ?? null);
      if (latestNational.report) {
        const detail = await client.getNationalReport(latestNational.report.id);
        setNationalApproved(detail.report.status === 'approved');
      } else {
        setNationalApproved(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load firm reports');
    }
  }, [client, editionId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  if (viewingFirm) {
    return (
      <FirmReportDocument
        source={firmSource(client, editionId, viewingFirm)}
        onBack={() => setViewingFirm(null)}
      />
    );
  }

  if (reports === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const firmName = (organizationId: string): string =>
    firms.find((f) => f.id === organizationId)?.displayName ?? organizationId;
  const failed = reports.filter((r) => r.generationState === 'failed');
  const generated = reports.filter((r) => r.generationState === 'generated');
  const released = reports.filter((r) => r.releaseState === 'released');
  const approved = reports.filter((r) => r.approvalState === 'approved');
  const readyToRelease = generated.filter((r) => r.approvalState === 'approved');
  const unlocked = reports.filter((r) => r.cutState === 'unlocked').length;
  const directional = reports.filter((r) => r.cutState === 'directional').length;

  function downloadList(): void {
    const rows = (reports ?? []).map(
      (r) => `${firmName(r.organizationId)},${r.retailN},Guaranteed,${CUT_LABEL[r.cutState]}`,
    );
    const csv = ['Firm,Own retail responses,Combined report,Retail category cut', ...rows].join(
      '\n',
    );
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `firm-reports-${editionId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main>
      <p className="eyebrow">Results · Firm reports</p>
      <h1 tabIndex={-1}>Firm reports</h1>
      <p className="lede">
        One report per participating firm. The combined report is guaranteed to every one of them;
        the category cut is additional and unlocks on the firm&rsquo;s own data.
      </p>

      {error && <div className="err">{error}</div>}

      {reports.length === 0 ? (
        <div className="warnbox">
          {generationAttempted ? (
            <>
              <b>There are no reports to release.</b>
              <p style={{ margin: '6px 0 0' }}>
                No firm completed any of S1, S2 or S3, so no firm report exists. This is not a
                suppression and nothing is being withheld — there is nothing to produce.
              </p>
            </>
          ) : (
            <b>No firm reports have been generated for this edition yet.</b>
          )}
          {!authoritativeRunId ? (
            <p style={{ margin: '6px 0 0' }}>
              A signed-off scoring run is required first — sign one off on Scoring.
            </p>
          ) : !generationAttempted ? (
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => {
                  setGenerationAttempted(true);
                  return doRun(() => client.generateFirmReports(editionId, authoritativeRunId));
                }}
              >
                Generate firm reports
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="statgrid">
            <div className="stat">
              <b>{reports.length}</b>
              <span>Firms receiving a report</span>
            </div>
            <div className="stat">
              <b>{unlocked}</b>
              <span>Retail cut unlocked</span>
            </div>
            <div className="stat">
              <b>{directional}</b>
              <span>Directional only</span>
            </div>
            <div className="stat">
              <b>{reports.length - unlocked - directional}</b>
              <span>Combined report only</span>
            </div>
          </div>

          <div className="tablebar">
            <span className="muted">{reports.length} participating firms</span>
            <button className="btn-2" type="button" onClick={downloadList}>
              Download the list
            </button>
          </div>

          <div className="tablewrap">
            <table className="ftbl">
              <thead>
                <tr>
                  <th>Firm</th>
                  <th>Own retail responses</th>
                  <th>Combined report</th>
                  <th>Retail category cut</th>
                  <th>Approved</th>
                  <th>Released</th>
                  <th>Report</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} className={r.generationState === 'failed' ? 'bad' : undefined}>
                    <td>{firmName(r.organizationId)}</td>
                    <td>{r.retailN}</td>
                    <td>
                      <span className="tag ok">Guaranteed</span>
                    </td>
                    <td>
                      <span
                        className={`tag ${r.cutState === 'unlocked' ? 'ok' : r.cutState === 'directional' ? 'wait' : 'soft'}`}
                      >
                        {CUT_LABEL[r.cutState]}
                      </span>
                    </td>
                    <td>
                      {r.approvalState === 'approved' ? (
                        <span className="tag ok">Approved</span>
                      ) : r.generationState === 'generated' ? (
                        <button
                          type="button"
                          className="btn-2"
                          disabled={busy}
                          onClick={() => doRun(() => client.approveFirmReport(r.id))}
                        >
                          Approve
                        </button>
                      ) : (
                        <span className="tag soft">Not generated</span>
                      )}
                    </td>
                    <td>
                      <span className={`tag ${r.releaseState === 'released' ? 'ok' : 'soft'}`}>
                        {r.releaseState === 'released'
                          ? 'Released'
                          : r.releaseState === 'held'
                            ? 'Held'
                            : 'Not released'}
                      </span>
                      {notices[r.id] && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                          {notices[r.id]!.sent > 0
                            ? `Emailed ${notices[r.id]!.sent}`
                            : notices[r.id]!.failed > 0
                              ? `Email failed (${notices[r.id]!.failed})`
                              : 'Notice recorded, not sent'}
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-2 small"
                        disabled={r.generationState !== 'generated'}
                        onClick={() => setViewingFirm(r.organizationId)}
                      >
                        View report
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {failed.length > 0 && (
            <div className="warnbox">
              <b>
                {failed.length} of {reports.length} failed to generate and are HELD.
              </b>
              <p style={{ margin: '6px 0 0' }}>A held report is held, not excluded.</p>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {failed.map((r) => (
                  <li key={r.id} style={{ margin: '4px 0' }}>
                    {firmName(r.organizationId)}{' '}
                    <button
                      type="button"
                      className="btn-2"
                      disabled={busy}
                      onClick={() => doRun(() => client.regenerateFirmReport(r.id))}
                    >
                      Retry generation
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <section className="stage now">
            <div className="stagehead">
              <h2>Releasing the reports</h2>
              <span className="pill wait">
                {released.length} of {reports.length} released
              </span>
            </div>
            <div className="stagebody">
              {!nationalApproved ? (
                <div className="warnbox">
                  <b>The national report has not been approved.</b>
                  <p style={{ margin: '6px 0 0' }}>
                    Firm reports carry the industry aggregate a firm is measured against. Releasing
                    them first would put the benchmark into the market before the report that
                    explains it.
                  </p>
                </div>
              ) : (
                <>
                  <p>
                    {readyToRelease.length} of {reports.length} reports are approved and ready. Each
                    releases on its own; a report that is not ready holds no other firm back.
                  </p>
                  {releaseResult && (
                    <div className="note">
                      <p>
                        Released to {releaseResult.released.length} firms, each with its written
                        analysis frozen as released. {noticeLine(releaseResult.notified)}{' '}
                        {releaseResult.held.length > 0 &&
                          `${releaseResult.held.length} held: ${releaseResult.held
                            .map((h) => `${firmName(h.organizationId)} (${h.reason})`)
                            .join(', ')}`}
                      </p>
                    </div>
                  )}
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy || approved.length === 0}
                      onClick={() =>
                        doRun(async () =>
                          setReleaseResult(await client.releaseFirmReports(editionId)),
                        )
                      }
                    >
                      {busy
                        ? 'Releasing — writing any missing analyses first…'
                        : `Release the ${readyToRelease.length} approved`}
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

/** How a release's notices to the firms' coordinators went, in one line. */
function noticeLine(n: { sent: number; logged: number; failed: number }): string {
  const parts: string[] = [];
  if (n.sent) parts.push(`${n.sent} coordinator email${n.sent === 1 ? '' : 's'} sent`);
  if (n.logged) {
    parts.push(
      `${n.logged} coordinator notice${n.logged === 1 ? '' : 's'} recorded but not sent — no mail server is configured (SMTP_URL)`,
    );
  }
  if (n.failed) parts.push(`${n.failed} email${n.failed === 1 ? '' : 's'} failed to send`);
  return parts.length ? `${parts.join('; ')}.` : 'No coordinators to notify.';
}
