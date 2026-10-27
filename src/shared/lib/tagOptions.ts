/** Search options only: the selected clipboard query is deliberately untouched. */
export const filterTagOptions = (tags: readonly string[], query: string) => {
  const all = Array.from(new Set(tags.filter(tag => tag.trim().length > 0)));
  const term = query.trim().toLowerCase();
  return { all, visible: term ? all.filter(tag => tag.toLowerCase().includes(term)) : all };
};
