import { useRef, useEffect } from 'react';

/**
 * Custom hook that returns true for the first render and false for subsequent renders
 */
export function useIsFirstRender(): boolean {
  const isFirstRender = useRef(true);

  useEffect(() => {
    // After the first render, set isFirstRender to false
    isFirstRender.current = false;
  }, []);

  return isFirstRender.current;
}
