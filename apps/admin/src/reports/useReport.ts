import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api/types';
import { saveFile } from './parts';
import type { ReportSource } from './source';

/**
 * Loading, drafting and downloading one report document, for whichever reader
 * the source is for. For an operator the narrative drafts itself once the
 * figures are in — nobody presses a button; the server leaves the narrative in
 * force alone unless it is missing or was written from figures that have since
 * changed. A firm or public reader only ever reads what was released.
 */
export function useReport<T extends { narrative: unknown; publishedAt?: string | null }>(
  source: ReportSource<T>,
  { printMode, onReady }: { printMode: boolean; onReady: (() => void) | undefined },
) {
  const [c, setC] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'generating' | 'downloading' | 'publishing' | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setC(await source.load());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the report');
    }
  }, [source]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (printMode || !source.ensure) return;
    let live = true;
    setBusy('generating');
    void source
      .ensure()
      .then(() => (live ? load() : undefined))
      .catch((err: unknown) => {
        if (live) {
          setAiError(
            err instanceof ApiError ? err.message : 'The AI narrative could not be drafted',
          );
        }
      })
      .finally(() => {
        if (live) setBusy(null);
      });
    return () => {
      live = false;
    };
  }, [source, printMode, load]);

  useEffect(() => {
    if (c) onReady?.();
  }, [c, onReady]);

  const run = async (
    kind: 'generating' | 'downloading' | 'publishing',
    action: () => Promise<void>,
    failure: string,
  ): Promise<void> => {
    setBusy(kind);
    setAiError(null);
    try {
      await action();
    } catch (err) {
      setAiError(err instanceof ApiError ? err.message : failure);
    } finally {
      setBusy(null);
    }
  };

  const regenerate = source.regenerate
    ? () =>
        run(
          'generating',
          async () => {
            await source.regenerate!();
            await load();
          },
          'The AI narrative could not be drafted',
        )
    : undefined;

  const publish = source.publish
    ? () =>
        run(
          'publishing',
          async () => {
            await source.publish!();
            await load();
          },
          'The report could not be published',
        )
    : undefined;

  const download = (filename: string) =>
    run(
      'downloading',
      async () => saveFile(await source.pdf(), filename),
      'The PDF could not be produced',
    );

  return { c, error, busy, aiError, regenerate, publish, download };
}
