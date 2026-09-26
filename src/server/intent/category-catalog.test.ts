import { expect, it } from 'vitest';
import { collectEmbeddedCatalog } from './category-catalog.mjs';

const root = { http_status: 200, body: {
  meta: { code: 200, issue_date: '20260922', api_version: '2.0.21574' },
  result: { total: 1, items: [{ id: '10', name: 'Досуг', type: 'general_rubric', region_id: '32',
    rubrics: [{ id: '20', name: 'Парки', type: 'rubric', region_id: '32', parent_id: '10' }] }] },
} };

it('constructs the request-scoped catalog from one root call', async () => {
  let calls = 0;
  const result = await collectEmbeddedCatalog({ regionId: '32', fetchRoot: async () => { calls++; return root; } });
  expect(calls).toBe(1);
  expect(result.summary).toMatchObject({ complete: true, http_calls: 1, unique_categories: 2 });
  expect(result.catalog?.items).toEqual([
    { id: '10', name: 'Досуг', type: 'general_rubric', caption: null, parent_ids: [], declared_parent_ids: [] },
    { id: '20', name: 'Парки', type: 'rubric', caption: null, parent_ids: ['10'], declared_parent_ids: ['10'] },
  ]);
});

it('rejects a partial root page without fetching more pages', async () => {
  let calls = 0;
  const result = await collectEmbeddedCatalog({ regionId: '32', fetchRoot: async () => {
    calls++; return { ...root, body: { ...root.body, result: { ...root.body.result, total: 2 } } };
  } });
  expect(calls).toBe(1);
  expect(result.catalog).toBeNull();
  expect(result.summary.error_code).toBe('INCOMPLETE_ROOT_PAGE');
});

it('rejects missing embedded children instead of silently narrowing categories', async () => {
  const result = await collectEmbeddedCatalog({ regionId: '32', fetchRoot: async () => ({
    ...root, body: { ...root.body, result: { ...root.body.result, items: [{ ...root.body.result.items[0], rubrics: undefined }] } },
  }) });
  expect(result.catalog).toBeNull();
  expect(result.summary.error_code).toBe('INCOMPLETE_EMBEDDED_TREE');
});
