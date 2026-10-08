import { useEffect, useState } from 'react';

/** Mirrors R.narrow(): a single viewport test used by every recomposing control. */
const NARROW = 640;

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState<boolean>(() =>
    typeof window !== 'undefined' ? window.innerWidth <= NARROW : false,
  );
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth <= NARROW);
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}
