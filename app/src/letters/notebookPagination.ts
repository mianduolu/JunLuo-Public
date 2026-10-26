export const NOTEBOOK_PAGE_SIZE = 8;

export function paginateNotebook<T>(entries: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / NOTEBOOK_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pageCount - 1);
  return {
    pageIndex,
    pageCount,
    entries: entries.slice(pageIndex * NOTEBOOK_PAGE_SIZE, (pageIndex + 1) * NOTEBOOK_PAGE_SIZE),
  };
}
