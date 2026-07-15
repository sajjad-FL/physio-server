export const PAGE_SIZE_OPTIONS = [10, 20, 50];

export function readPagination(query, { defaultLimit = 10, maxLimit = 50 } = {}) {
  const page = Math.max(1, Math.floor(Number(query?.page) || 1));
  const requested = Math.max(1, Math.floor(Number(query?.limit) || defaultLimit));
  const limit = Math.min(maxLimit, requested);
  return { page, limit, skip: (page - 1) * limit };
}

export function paginationMeta({ page, limit, total }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  return {
    page,
    limit,
    total: safeTotal,
    totalPages: Math.max(1, Math.ceil(safeTotal / limit)),
  };
}
