export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export function parsePagination(query: Record<string, unknown>): Pagination {
  const rawPage = query.page;
  const rawPageSize = query.pageSize;

  const page = typeof rawPage === "string" && /^\d+$/.test(rawPage) ? Math.max(1, parseInt(rawPage, 10)) : 1;
  const pageSize =
    typeof rawPageSize === "string" && /^\d+$/.test(rawPageSize)
      ? Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(rawPageSize, 10)))
      : DEFAULT_PAGE_SIZE;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function paginated<T>(items: T[], total: number, pagination: Pagination) {
  return {
    items,
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

export function queryString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
