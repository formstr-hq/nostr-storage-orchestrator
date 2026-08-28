import { getEventHash, matchFilter, verifyEvent, type Filter, type NostrEvent } from "nostr-tools";

export function eventMatchesFilters(event: NostrEvent, filters: Filter[]): boolean {
  return filters.some((filter) => matchFilter(filter, event));
}

export function isValidForwardableEvent(event: NostrEvent, filters: Filter[]): boolean {
  if (!verifyEvent(event)) {
    return false;
  }
  if (getEventHash(event) !== event.id) {
    return false;
  }
  return eventMatchesFilters(event, filters);
}
