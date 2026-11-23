import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/** URL owns the committed query; only the current input draft is debounced. */
export function useIpSearchQuery() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlQuery = searchParams.get('q') ?? '';
  const keyword = urlQuery.trim();
  const [searchValue, setSearchValue] = useState(urlQuery);
  useEffect(() => setSearchValue(urlQuery), [urlQuery]);
  useEffect(() => {
    const wanted = searchValue.trim();
    if (wanted === keyword) return;
    const timer = window.setTimeout(() => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current);
        if (wanted) next.set('q', wanted);
        else next.delete('q');
        return next;
      }, { replace: true });
    }, 220);
    return () => window.clearTimeout(timer);
  }, [searchValue, keyword, setSearchParams]);
  return { searchValue, setSearchValue, keyword, awaitingKeyword: searchValue.trim() !== keyword };
}
