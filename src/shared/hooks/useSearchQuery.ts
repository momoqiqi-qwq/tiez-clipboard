import { useCallback, useEffect, useRef, useState } from "react";

/** Text input is debounced; explicit filter actions commit synchronously. */
export const useSearchQuery = (value: string, setValue: (value: string) => void, delay = 400) => {
  const [query, setQuery] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    timerRef.current = setTimeout(() => setQuery(value), delay);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value, delay]);
  const commit = useCallback((next: string) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setQuery(next);
    setValue(next);
  }, [setValue]);
  return { query, commit };
};
