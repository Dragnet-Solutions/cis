import { useEffect, useState } from 'react';
import { journeyApi } from './journeyClient';

/**
 * UX-PUB-002 — Previous editions. Year 1 renders the empty state only; the
 * underlying query already supports a second edition with no further backend
 * changes once one exists (Phase 6's approved national reports).
 */
export function PreviousEditions({
  currentEditionId,
  onBack,
}: {
  currentEditionId: string | null;
  onBack: () => void;
}): JSX.Element {
  const [editions, setEditions] = useState<Array<{
    editionId: string;
    editionLabel: string;
    publicationStatus: string;
    lineageNote: string;
  }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void journeyApi.previousEditions(currentEditionId).then((rows) => {
      if (!cancelled) setEditions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [currentEditionId]);

  return (
    <div className="journey">
      <h1 tabIndex={-1}>Previous editions</h1>

      {editions && editions.length === 0 && (
        <div className="card">
          <p>There are no previous published editions yet.</p>
          <p className="lede">
            When later editions are published, this page lists each immutable published report with
            its edition year and methodology-change note. The current edition is not duplicated here
            as "previous".
          </p>
        </div>
      )}

      {editions && editions.length > 0 && (
        <table className="ftbl">
          <thead>
            <tr>
              <th scope="col">Edition</th>
              <th scope="col">Status</th>
              <th scope="col">Lineage</th>
            </tr>
          </thead>
          <tbody>
            {editions.map((e) => (
              <tr key={e.editionId + e.lineageNote}>
                <td>{e.editionLabel}</td>
                <td>{e.publicationStatus}</td>
                <td>{e.lineageNote}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <button type="button" className="btn-2" onClick={onBack}>
        Back
      </button>
    </div>
  );
}
