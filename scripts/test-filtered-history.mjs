// Run with: node scripts/test-filtered-history.mjs
// Lightweight hook harness: checks filtering semantics and memo dependencies,
// not React DOM integration. Uses the project's existing TypeScript dependency.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const searchModule = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/shared/lib/historySearch.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText, { exports: searchModule });

const source = readFileSync(new URL('../src/shared/hooks/useFilteredHistory.ts', import.meta.url), 'utf8');
let cursor = 0;
const slots = [];
const calls = [];
const useMemo = (fn, deps) => {
  const index = cursor++;
  const previous = slots[index];
  if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return previous.value;
  calls[index] = (calls[index] || 0) + 1;
  const value = fn();
  slots[index] = { deps, value };
  return value;
};
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText, { exports, require: name => {
  if (name === '../lib/historySearch') return searchModule;
  assert.equal(name, 'react');
  return { useMemo };
}});
const render = (history, search = '', typeFilter = null) => {
  cursor = 0;
  return exports.useFilteredHistory({ history, search, typeFilter });
};
const ids = items => Array.from(items, item => item.id);
const history = Object.freeze([
  { id: 1, timestamp: 30, is_pinned: false, content: 'Alpha', content_type: 'text', tags: ['Work'] },
  { id: 2, timestamp: 10, is_pinned: true, pinned_order: 2, content: 'beta', content_type: 'text', source_app: 'Editor' },
  { id: 3, timestamp: 40, is_pinned: false, content: 'ALPHA', content_type: 'image', tags: ['work'] },
  { id: 4, timestamp: 20, is_pinned: true, pinned_order: 3, content_type: 'text', tags: ['Private'] },
  { id: 5, timestamp: 20, is_pinned: true, pinned_order: 2, content_type: 'text' },
  { id: 6, timestamp: 30, is_pinned: false, content: 'Alpha', content_type: 'text' }
].map(Object.freeze));
const sorted = render(history);
assert.deepEqual(ids(sorted), [4, 5, 2, 3, 1, 6]);
assert.deepEqual(ids(render(history, 'alpha')), [3, 1, 6]);
assert.deepEqual(ids(render(history, 'EDITOR')), [2]);
assert.deepEqual(ids(render(history, 'work')), [3, 1]);
assert.deepEqual(ids(render(history, 'TAG:WORK')), [3, 1]);
assert.deepEqual(ids(render(history, '  TaG:  WORK  ')), [3, 1]);
assert.strictEqual(render(history, ' TAG:   '), sorted);
assert.strictEqual(render(history, '   '), sorted);
assert.deepEqual(ids(render(history, 'tag:alpha')), []);
assert.deepEqual(ids(render(history, '', 'image')), [3]);
assert.deepEqual(ids(render(history, 'alpha', 'text')), [1, 6]);
assert.deepEqual(ids(render(history, 'missing')), []);
assert.strictEqual(render(history, 'tag:'), sorted);
assert.strictEqual(render(history), sorted);
assert.equal(calls[0], 1, 'Search/type changes must not repeat sorting');
const filterCalls = calls[1];
assert.strictEqual(render(history), sorted);
assert.equal(calls[1], filterCalls, 'Unchanged inputs must reuse filtering');
assert.deepEqual(ids(history), [1, 2, 3, 4, 5, 6]);
const updated = [...history, { id: 7, timestamp: 100, is_pinned: false, content: 'new' }];
assert.deepEqual(ids(render(updated)), [4, 5, 2, 7, 3, 1, 6]);
assert.equal(calls[0], 2, 'Changed history must invalidate ordering');
assert.deepEqual(ids(render([])), []);
console.log('PASS: ordering, ties, content/app/tag/type filters, missing fields, immutable input, memo reuse and invalidation');
