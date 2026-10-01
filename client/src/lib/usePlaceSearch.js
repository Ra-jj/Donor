import { useCallback, useEffect, useRef, useState } from 'react';
import { PlaceSearchError, millisecondsUntilNextSearch, searchPlaces } from './nominatim';

/**
 * Runs Nominatim place searches for one form (lib/nominatim.js), one at a time.
 *
 * - search(query, { limit }) resolves with the places found, and resolves null without sending
 *   anything while a search is already running (that search's answer is the one to show). It
 *   rejects with a PlaceSearchError when the search fails, and with code 'too_soon', without
 *   sending anything, while the wait before the next search has not passed, so the form can say so.
 * - isSearching is true while a request is out.
 * - isSearchBlocked is also true until the next search may be sent, so the Search button can be
 *   disabled for exactly that long (one second, or longer after a 429).
 * Leaving the page cancels a search still running.
 */
export const usePlaceSearch = () => {
  const [isSearching, setIsSearching] = useState(false);
  // The wait is shared by every form on the page, so it can still be running from another one
  const [isWaitingToSearch, setIsWaitingToSearch] = useState(() => millisecondsUntilNextSearch() > 0);
  // State updates land after the event: a second Enter in the same moment reads these instead
  const isSearchRunningRef = useRef(false);
  const controllerRef = useRef(null);
  const waitTimerRef = useRef(null);

  const endWaitOnTime = useCallback(() => {
    clearTimeout(waitTimerRef.current);
    waitTimerRef.current = setTimeout(() => setIsWaitingToSearch(false), millisecondsUntilNextSearch());
  }, []);

  const blockUntilNextSearchAllowed = useCallback(() => {
    if (millisecondsUntilNextSearch() <= 0) return;
    setIsWaitingToSearch(true);
    endWaitOnTime();
  }, [endWaitOnTime]);

  useEffect(() => {
    // A wait that was already running when the form appeared (see the initial state above)
    if (millisecondsUntilNextSearch() > 0) endWaitOnTime();
    return () => {
      controllerRef.current?.abort();
      clearTimeout(waitTimerRef.current);
    };
  }, [endWaitOnTime]);

  const search = useCallback(
    async (query, { limit } = {}) => {
      if (isSearchRunningRef.current) return null;
      if (millisecondsUntilNextSearch() > 0) {
        blockUntilNextSearchAllowed();
        throw new PlaceSearchError('too_soon', 'The wait before the next search has not passed.');
      }
      isSearchRunningRef.current = true;
      setIsSearching(true);
      const controller = new AbortController();
      controllerRef.current = controller;
      try {
        return await searchPlaces(query, { limit, signal: controller.signal });
      } finally {
        isSearchRunningRef.current = false;
        controllerRef.current = null;
        setIsSearching(false);
        blockUntilNextSearchAllowed();
      }
    },
    [blockUntilNextSearchAllowed],
  );

  return { search, isSearching, isSearchBlocked: isSearching || isWaitingToSearch };
};
