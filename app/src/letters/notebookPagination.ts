export const NOTEBOOK_PAGE_SIZE = 8;

export function notebookPageIndexFromInput(input: string, pageCount: number): number | undefined {
  const value = input.trim();
  if (!/^\d+$/u.test(value) || !Number.isSafeInteger(pageCount) || pageCount < 1) return undefined;
  const page = Number(value);
  return Number.isSafeInteger(page) && page >= 1 && page <= pageCount ? page - 1 : undefined;
}

export function paginateNotebook<T>(entries: readonly T[], requestedPage: number) {
  const pageCount = Math.max(1, Math.ceil(entries.length / NOTEBOOK_PAGE_SIZE));
  const pageIndex = Math.min(Math.max(0, Math.trunc(requestedPage) || 0), pageCount - 1);
  return {
    pageIndex,
    pageCount,
    entries: entries.slice(pageIndex * NOTEBOOK_PAGE_SIZE, (pageIndex + 1) * NOTEBOOK_PAGE_SIZE),
  };
}
