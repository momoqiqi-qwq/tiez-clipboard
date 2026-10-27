/** Shared by header state, local filtering and IPC requests. */
export const parseHistorySearch = (search: string) => {
  const trimmed = search.trim();
  const tagOnly = /^tag:/i.test(trimmed);
  const term = tagOnly ? trimmed.slice(4).trim() : trimmed;
  return { tagOnly, term, normalizedTerm: term.toLowerCase() };
};
