import assert from 'node:assert/strict'
import { readPagination, paginationMeta, PAGE_SIZE_OPTIONS } from '../utils/pagination.js'

assert.deepEqual(PAGE_SIZE_OPTIONS, [10, 20, 50])

assert.deepEqual(readPagination({}), { page: 1, limit: 10, skip: 0 })
assert.deepEqual(readPagination({ page: '2', limit: '10' }), { page: 2, limit: 10, skip: 10 })
assert.deepEqual(readPagination({ page: 0, limit: 999 }), { page: 1, limit: 50, skip: 0 })
assert.deepEqual(readPagination({ page: '3', limit: '20' }, { defaultLimit: 10, maxLimit: 20 }), {
  page: 3,
  limit: 20,
  skip: 40,
})

assert.deepEqual(paginationMeta({ page: 1, limit: 10, total: 0 }), {
  page: 1,
  limit: 10,
  total: 0,
  totalPages: 1,
})
assert.deepEqual(paginationMeta({ page: 2, limit: 10, total: 25 }), {
  page: 2,
  limit: 10,
  total: 25,
  totalPages: 3,
})

console.log('pagination utils ok')
