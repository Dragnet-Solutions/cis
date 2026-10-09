import { useCallback, useEffect, useState } from 'react';
import { operatorFirmSource as firmSource } from '../reports/source';
import { FirmReport as FirmReportDocument } from '../reports/FirmReport';
import type { AdminClient } from '../api/client';
import {
  ApiError,
  type AuthUser,
  type FirmReport,
  type FirmSummary,
  type PendingFirmReportRelease,
  type ReleaseFirmReportsResult,
} from '../api/types';
import { CriticalActionRequest, CriticalActionReview } from '../components/MakerChecker';

/**
 * UX-ADM-006 — Firm report generation & release, live-wired to the real
 * evaluator (`@cis/domain` firm-report-service, via
 * `apps/api/src/routes/reporting.ts`): the guarantee (every participating firm
 * gets its combined report) is a separate rule from the retail-cut
 * sufficiency gate; release is ATOMIC PER REPORT — a failed report is HELD,
 * not excluded, and holds no other firm back; release is blocked until the
 * national report is approved.
 *
 * Releasing the firm reports is one of the six critical actions, so it needs
 * two people: one requests release of the generated reports with a reason; a
 * different person approves, which releases them. Every report in the request
 * must have been opened by one of the two first — opening a report here
 * records it. A maker never sees a way to approve their own request.
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

const RELEASE_COPY = {
  title: 'Release the firm reports',
  does: 'Every firm in this request sees its report as soon as it is approved.',
  undo: 'Nothing released is ever recalled. A correction is a new version of the report, sent separately.',
};

/** "1 firm", "3 firms". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

type View = 'main' | 'request' | 'review';

export function FirmReportsPage({
  client,
  editionId,
  viewer,
}: {
  client: AdminClient;
  editionId: string;
  viewer: AuthUser;
}): JSX.Element {
  const [reports, setReports] = useState<FirmReport[] | null>(null);
  const [openedBy, setOpenedBy] = useState<
    Record<string, Array<{ id: string; displayName: string }>>
  >({});
  const [pending, setPending] = useState<PendingFirmReportRelease | null>(null);
  const [firms, setFirms] = useState<FirmSummary[]>([]);
  const [authoritativeRunId, setAuthoritativeRunId] = useState<string | null>(null);
  const [nationalApproved, setNationalApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('main');
  const [releaseResult, setReleaseResult] = useState<ReleaseFirmReportsResult | null>(null);
  const [notices, setNotices] = useState<
    Record<string, { sent: number; logged: number; failed: number; queued: number }>
  >({});
  const [notice, setNotice] = useState<string | null>(null);
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
      setOpenedBy(reportsRes.openedBy ?? {});
      setPending(reportsRes.pendingRelease ?? null);
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
        setView('main');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // Opening a report records that this person has read it — approval needs it.
  const openReport = useCallback(
    async (r: FirmReport) => {
      setError(null);
      try {
        await client.openFirmReport(r.id);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not record that you opened it');
      }
      setViewingFirm(r.organizationId);
    },
    [client],
  );

  if (viewingFirm) {
    return (
      <FirmReportDocument
        source={firmSource(client, editionId, viewingFirm)}
        onBack={() => {
          setViewingFirm(null);
          void load();
        }}
      />
    );
  }

  if (reports === null) {
    return <main>{error ? <div className="err">{error}</div> : <p>Loading…</p>}</main>;
  }

  const firmName = (organizationId: string): string =>
    firms.find((f) => f.id === organizationId)?.displayName ?? organizationId;
  const reportById = new Map(reports.map((r) => [r.id, r]));
  const openedByAny = (reportId: string, people: string[]): boolean =>
    (openedBy[reportId] ?? []).some((u) => people.includes(u.id));

  const failed = reports.filter((r) => r.generationState === 'failed');
  const released = reports.filter((r) => r.releaseState === 'released');
  const pendingIds = new Set(pending?.reportIds ?? []);
  // Generated, not yet approved or released, and not already in a request.
  const requestable = reports.filter(
    (r) =>
      r.generationState === 'generated' &&
      r.approvalState !== 'approved' &&
      r.releaseState !== 'released' &&
      !pendingIds.has(r.id),
  );
  const requestableOpenedByViewer = requestable.filter((r) => openedByAny(r.id, [viewer.id]));
  // Approved by two people but not out yet (held while the analysis could not
  // be prepared) — "Release again" sends these.
  const approvedNotReleased = reports.filter(
    (r) => r.approvalState === 'approved' && r.releaseState !== 'released',
  );
  const unlocked = reports.filter((r) => r.cutState === 'unlocked').length;
  const directional = reports.filter((r) => r.cutState === 'directional').length;

  // For the pending request: which covered reports neither the requester nor
  // this viewer has opened yet.
  const deciders = pending ? [pending.requestedBy.id, viewer.id] : [];
  const pendingReports = (pending?.reportIds ?? [])
    .map((id) => reportById.get(id))
    .filter((r): r is FirmReport => !!r);
  const pendingUnopened = pendingReports.filter((r) => !openedByAny(r.id, deciders));
  const isOwnRequest = !!pending && pending.requestedBy.id === viewer.id;

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

  if (view === 'request') {
    return (
      <main>
        <CriticalActionRequest
          eyebrow="Needs a second person"
          title={RELEASE_COPY.title}
          doesText={`${count(requestable.length, 'report', 'reports')} in this request. ${RELEASE_COPY.does}`}
          undoText={RELEASE_COPY.undo}
          busy={busy}
          onCancel={() => setView('main')}
          onSubmit={(reason) =>
            doRun(() =>
              client.requestFirmReportRelease(
                editionId,
                reason,
                requestable.map((r) => r.id),
              ),
            )
          }
        />
        {requestableOpenedByViewer.length < requestable.length && (
          <div className="note">
            <p>
              You have opened {requestableOpenedByViewer.length} of {requestable.length}. Before it
              can be approved, each report must be opened by you or by the person who approves.
            </p>
          </div>
        )}
        {error && <div className="err">{error}</div>}
      </main>
    );
  }

  if (view === 'review' && pending) {
    return (
      <main>
        <CriticalActionReview
          eyebrow="Someone has asked for this"
          title={RELEASE_COPY.title}
          doesText={`${count(pendingReports.length, 'report', 'reports')} in this request. ${RELEASE_COPY.does}`}
          undoText={RELEASE_COPY.undo}
          pending={pending}
          viewer={viewer}
          busy={busy}
          onBack={() => setView('main')}
          onDecide={(approved) =>
            doRun(async () => {
              const res = await client.decideFirmReportRelease(editionId, pending.id, approved);
              if (res.released && res.held && res.notified) {
                setReleaseResult({
                  released: res.released,
                  held: res.held,
                  notified: res.notified,
                });
              }
              setNotice(
                res.status === 'rejected'
                  ? 'The request was rejected. Nothing was approved or released.'
                  : res.releaseError
                    ? `The reports were approved, but the release did not finish: ${res.releaseError}`
                    : null,
              );
            })
          }
        />
        {!isOwnRequest && pendingUnopened.length > 0 && (
          <div className="warnbox">
            <b>
              {count(pendingUnopened.length, 'report has', 'reports have')} not been opened by you
              or {pending.requestedBy.displayName}.
            </b>
            <p style={{ margin: '6px 0 0' }}>
              Each report must be read by one of you before it can be approved.
            </p>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {pendingUnopened.map((r) => (
                <li key={r.id} style={{ margin: '4px 0' }}>
                  {firmName(r.organizationId)}{' '}
                  <button type="button" className="btn-2 small" onClick={() => void openReport(r)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="err">{error}</div>}
      </main>
    );
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
      {notice && <div className="note">{notice}</div>}

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
              <span>
                {reports.length === 1 ? 'Firm receiving a report' : 'Firms receiving a report'}
              </span>
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
            <span className="muted">
              {count(reports.length, 'participating firm', 'participating firms')}
            </span>
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
                  <th>Opened by</th>
                  <th>Approved</th>
                  <th>Released</th>
                  <th>Report</th>
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => {
                  const readers = openedBy[r.id] ?? [];
                  return (
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
                        {readers.length === 0 ? (
                          <span className="muted">Not yet</span>
                        ) : (
                          readers
                            .map((u) => (u.id === viewer.id ? 'You' : u.displayName))
                            .join(', ')
                        )}
                      </td>
                      <td>
                        {r.approvalState === 'approved' ? (
                          <span className="tag ok">Approved</span>
                        ) : pendingIds.has(r.id) ? (
                          <span className="tag wait">Awaiting a second person</span>
                        ) : r.generationState === 'generated' ? (
                          <span className="tag soft">Not requested</span>
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
                          onClick={() => void openReport(r)}
                        >
                          Open report
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {failed.length > 0 && (
            <div className="warnbox">
              <b>
                {failed.length} of {reports.length} failed to generate and{' '}
                {failed.length === 1 ? 'is' : 'are'} held.
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
              <p>
                Releasing needs two people. One asks for the reports to be released and says why; a
                different person approves, and approving releases them. Each report must be opened
                by one of the two before it can be approved. Each report releases on its own; a
                report that is not ready holds no other firm back.
              </p>

              {!nationalApproved && (
                <div className="warnbox">
                  <b>The national report has not been approved.</b>
                  <p style={{ margin: '6px 0 0' }}>
                    Firm reports carry the industry aggregate a firm is measured against. Releasing
                    them first would put the benchmark into the market before the report that
                    explains it. A release can be requested now, but it cannot be approved until the
                    national report is.
                  </p>
                </div>
              )}

              {releaseResult && (
                <div className="note">
                  <p>
                    {releaseResult.released.length > 0
                      ? `Released to ${count(releaseResult.released.length, 'firm', 'firms')}, each with its written analysis frozen as released. ${noticeLine(releaseResult.notified)}`
                      : 'No report went out.'}
                    {releaseResult.held.length > 0 &&
                      ` ${releaseResult.held.length} held: ${releaseResult.held
                        .map((h) => `${firmName(h.organizationId)} (${h.reason})`)
                        .join(', ')}`}
                  </p>
                </div>
              )}

              {pending ? (
                <div className="warnbox">
                  <b>Awaiting a second person</b>
                  <p style={{ margin: '6px 0 0' }}>
                    Release of {count(pendingReports.length, 'report', 'reports')} requested by{' '}
                    {pending.requestedBy.displayName} ·{' '}
                    {new Date(pending.requestedAt).toLocaleString()}
                  </p>
                  {isOwnRequest ? (
                    <p style={{ margin: '6px 0 0' }}>
                      This is your own request. Someone else has to approve it.
                    </p>
                  ) : (
                    <p style={{ margin: '6px 0 0' }}>
                      {pendingReports.length - pendingUnopened.length} of {pendingReports.length}{' '}
                      opened by you or {pending.requestedBy.displayName}.
                    </p>
                  )}
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => setView('review')}>
                      Review the request
                    </button>
                  </div>
                </div>
              ) : requestable.length > 0 ? (
                <>
                  <p>
                    {count(requestable.length, 'report is', 'reports are')} generated and waiting
                    for approval. You have opened {requestableOpenedByViewer.length} of them.
                  </p>
                  <div className="actions">
                    <button type="button" className="btn" onClick={() => setView('request')}>
                      Request release of {count(requestable.length, 'report', 'reports')}
                    </button>
                  </div>
                </>
              ) : null}

              {nationalApproved && approvedNotReleased.length > 0 && !pending && (
                <>
                  <p>
                    {count(approvedNotReleased.length, 'report was', 'reports were')} approved but
                    did not go out. Releasing again sends only reports two people have already
                    approved.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn-2"
                      disabled={busy}
                      onClick={() =>
                        doRun(async () =>
                          setReleaseResult(await client.releaseFirmReports(editionId)),
                        )
                      }
                    >
                      {busy
                        ? 'Releasing — writing any missing analyses first…'
                        : `Release ${count(approvedNotReleased.length, 'approved report', 'approved reports')} again`}
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
