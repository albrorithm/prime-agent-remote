import { useSyncExternalStore } from "react";
import { pendingQuotesSnapshot, subscribePendingQuotes, type PendingQuote } from "../quote";

/** The quotation waiting in this session's composer, if any. */
export function usePendingQuote(agentId: string): PendingQuote | undefined {
  const quotes = useSyncExternalStore(subscribePendingQuotes, pendingQuotesSnapshot, pendingQuotesSnapshot);
  return quotes.get(agentId);
}
