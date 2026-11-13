// Run: node scripts/test-history-fetch.mjs
// Deterministic IPC/hook harness; does not replace desktop integration testing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const searchModule = {};
vm.runInNewContext(ts.transpileModule(
  readFileSync(new URL('../src/shared/lib/historySearch.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } }
).outputText, { exports: searchModule });
const source = readFileSync(new URL('../src/shared/hooks/useHistoryFetch.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const entry = id => ({ id, timestamp: id, content_type: 'text', is_pinned: false, content: 'hello', tags: [] });
function harness(search = '', overrides = {}) {
  const state = { history: [entry(1)], offset: 1, more: true, loading: false };
  const requests = [], cleanups = [], writes = [];
  const setter = key => value => {
    writes.push(key);
    state[key] = typeof value === 'function' ? value(state[key]) : value;
  };
  const exports = {};
  vm.runInNewContext(code, { exports, console: { error() {} }, require(name) {
    if (name === '../lib/historySearch') return searchModule;
    if (name === 'react') return {
      useRef: current => ({ current }), useCallback: fn => fn,
      useState: initial => { state.request = initial; return [initial, setter('request')]; },
      useEffect: fn => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); }
    };
    assert.equal(name, '@tauri-apps/api/core');
    return { invoke: (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })) };
  }});
  const api = exports.useHistoryFetch({ debouncedSearch: search, typeFilter: null,
    persistentLimitEnabled: false, persistentLimit: 100, pageSize: 2,
    currentOffset: 1, historyLength: 1, isLoadingMore: false, hasMore: true,
    setHistory: setter('history'), setCurrentOffset: setter('offset'),
    setHasMore: setter('more'), setIsLoadingMore: setter('loading'), ...overrides });
  return { api, state, requests, writes, unmount: () => cleanups.forEach(fn => fn()) };
}
{
  const h = harness();
  const old = h.api.fetchHistory(true), latest = h.api.fetchHistory(true);
  h.requests[1].resolve([entry(2), entry(3), entry(4)]); await latest;
  const count = h.writes.length;
  h.requests[0].reject(new Error('old failed')); await old;
  assert.equal(h.writes.length, count);
  assert.equal(h.state.more, true);
  assert.deepEqual(h.state.history.map(x => x.id), [2, 3]);
}
{
  const h = harness();
  const old = h.api.fetchHistory(true), latest = h.api.fetchHistory(true);
  h.requests[1].resolve([entry(9)]); await latest;
  h.requests[0].resolve([entry(2)]); await old;
  assert.equal(h.state.history[0].id, 9);
}
{
  const h = harness('hello');
  const original = h.state.history;
  const pending = h.api.fetchHistory(true);
  h.requests[0].reject(new Error('search failed')); await pending;
  assert.strictEqual(h.state.history, original);
  assert.equal(h.state.offset, 1);
  assert.equal(h.state.more, true);
}
{
  const h = harness();
  const failed = h.api.loadMoreHistory();
  const duplicate = h.api.loadMoreHistory();
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error('temporary')); await failed; await duplicate;
  assert.equal(h.state.loading, false);
  assert.equal(h.state.more, true);
  const retry = h.api.retryHistory();
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].args.offset, 1);
  h.requests[1].resolve([entry(2)]); await retry;
  assert.deepEqual(Array.from(h.state.history, x => x.id), [1, 2]);
}
for (const search of ['', 'hello']) {
  for (const bad of [null, {}, [null], [{ ...entry(2), tags: [3] }], [{ ...entry(2), content: {} }], [{ ...entry(2), timestamp: NaN }]]) {
    const h = harness(search), original = h.state.history;
    const pending = h.api.fetchHistory(true);
    h.requests[0].resolve(bad); await pending;
    assert.strictEqual(h.state.history, original);
    assert.equal(h.state.offset, 1);
  }
  const h = harness(search);
  const pending = h.api.fetchHistory(true);
  h.requests[0].resolve([]); await pending;
  assert.equal(h.state.history.length, 0);
  assert.equal(h.state.more, false);
}
for (const reject of [false, true]) {
  const h = harness();
  const pending = h.api.loadMoreHistory();
  h.unmount();
  const count = h.writes.length;
  if (reject) h.requests[0].reject(new Error('unmounted'));
  else h.requests[0].resolve([entry(2)]);
  await pending;
  await h.api.fetchHistory(true);
  await h.api.loadMoreHistory();
  assert.equal(h.writes.length, count);
  assert.equal(h.requests.length, 1);
}
console.log('PASS: stale success/failure, search preservation, pagination retry, concurrent-load guard, malformed responses, empty results, unmount safety');
for (const query of ['TAG:Work', '  TaG: Work  ']) {
  const h = harness(query), pending = h.api.fetchHistory(true);
  assert.equal(h.requests[0].command, 'search_clipboard_history');
  assert.equal(h.requests[0].args.searchTerm, 'Work');
  assert.equal(h.requests[0].args.tagOnly, true);
  h.requests[0].resolve([]); await pending;
}
for (const query of ['tag:', '  TAG:  ', '   ']) {
  const h = harness(query), pending = h.api.loadMoreHistory();
  assert.equal(h.requests[0].command, 'get_clipboard_history');
  h.requests[0].resolve([]); await pending;
}
console.log('PASS: normalized tag IPC requests and empty-tag pagination');
// Tag pagination must exhaust the complete backend result set, not stop at 200.
{
  const h = harness('TAG:工作', { pageSize: 37, typeFilter: 'text' });
  const dataset = Array.from({ length: 261 }, (_, index) => ({ ...entry(index + 1), tags: ['工作'] }));
  let pending = h.api.fetchHistory(true);
  let pageCount = 0;
  while (true) {
    const request = h.requests.at(-1);
    assert.equal(request.args.contentType, 'text');
    assert.equal(request.args.tagOnly, true);
    assert.equal(request.args.limit, 38);
    assert.equal(request.args.offset, pageCount * 37);
    request.resolve(dataset.slice(request.args.offset, request.args.offset + request.args.limit));
    await pending;
    pageCount++;
    if (!h.state.more) break;
    assert.ok(pageCount < 20, 'Pagination must make progress');
    pending = h.api.loadMoreHistory();
  }
  assert.equal(h.state.history.length, 261);
  assert.equal(new Set(h.state.history.map(item => item.id)).size, 261);
  assert.equal(h.state.offset, 261);
}
{
  const h = harness('tag:Work');
  let pending = h.api.fetchHistory(true);
  h.requests.at(-1).resolve([entry(0), entry(0), entry(2)]); await pending;
  assert.equal(h.state.offset, 2, 'Transient rows consume search offsets too');
  pending = h.api.loadMoreHistory();
  assert.equal(h.requests.at(-1).args.offset, 2);
  h.requests.at(-1).reject(new Error('temporary')); await pending;
  pending = h.api.retryHistory();
  assert.equal(h.requests.at(-1).args.offset, 2, 'Failed page retries at same offset');
  h.requests.at(-1).resolve([entry(2), entry(3), entry(4)]); await pending;
  pending = h.api.loadMoreHistory();
  assert.equal(h.requests.at(-1).args.offset, 4);
  h.requests.at(-1).resolve([entry(3), entry(4), entry(5)]); await pending;
  assert.equal(h.state.offset, 6, 'Deduplication must not rewind the consumed offset');
  assert.deepEqual(Array.from(h.state.history, item => item.id), [0, 0, 2, 3, 4]);
}
{
  const h = harness('tag:Work');
  const old = h.api.fetchHistory(true), latest = h.api.fetchHistory(true);
  h.requests[1].resolve([entry(9)]); await latest;
  h.requests[0].resolve([entry(2), entry(3), entry(4)]); await old;
  assert.equal(h.state.history[0].id, 9);
  assert.equal(h.state.offset, 1);
  assert.equal(h.state.more, false);
}
console.log('PASS: 261 tag results, type filter forwarding, transient offsets, retry, deduplication and stale tag responses');
{
  const h = harness('tag:Work');
  const reset = h.api.fetchHistory(true);
  await h.api.loadMoreHistory();
  assert.equal(h.requests.length, 1, 'Load-more must not supersede a pending reset');
  h.requests[0].reject(new Error('initial query failed')); await reset;
  const retry = h.api.retryHistory();
  assert.equal(h.requests[1].args.offset, 0, 'First successful query must start at zero');
  h.requests[1].resolve([entry(8)]); await retry;
  assert.deepEqual(Array.from(h.state.history, item => item.id), [8], 'Retry must replace data from the previous query');
}
console.log('PASS: reset/load-more race and first-page retry');
{
  const h = harness('tag:Work');
  const pending = h.api.fetchHistory(true);
  assert.equal(h.state.request.phase, 'loading');
  h.requests[0].reject(new Error('offline')); await pending;
  assert.equal(h.state.request.phase, 'error');
  await h.api.loadMoreHistory();
  assert.equal(h.requests.length, 1, 'Automatic loading must pause after failure');
  const retry = h.api.retryHistory();
  assert.equal(h.state.request.phase, 'loading');
  h.requests[1].resolve([entry(4)]); await retry;
  assert.equal(h.state.request.phase, 'ready');
  assert.equal(h.state.request.limited, false);
}
{
  const h = harness('hello');
  const pending = h.api.fetchHistory(true);
  h.requests[0].resolve(Array.from({length: 200}, (_, i) => entry(i + 1))); await pending;
  assert.equal(h.state.request.limited, true, 'Capped full-text results must not be presented as a total');
}
console.log('PASS: loading/error/retry states, no automatic retry loop, capped-result indicator');
{
  const h = harness('', { hasMore: false, typeFilter: 'image' });
  const pending = h.api.fetchHistory(false);
  assert.equal(h.requests[0].args.contentType, 'image');
  h.requests[0].reject(new Error('refresh failed')); await pending;
  const retry = h.api.retryHistory();
  assert.equal(h.requests.length, 2, 'Retry a failed direct refresh even when pagination is exhausted');
  assert.equal(h.requests[1].args.offset, 0);
  h.requests[1].resolve([]); await retry;
  assert.equal(h.state.request.phase, 'ready');
}
console.log('PASS: type-filter IPC casing and retry with exhausted pagination');

for (const query of ['', 'report', 'tag:Work']) {
  const h = harness(query, { pageSize: 37, fileExtensions: ['pdf', 'docx'] });
  const dataset = Array.from({length: 261}, (_, i) => ({ ...entry(i + 1), content_type: 'file', content: `report-${i}.pdf` }));
  let pending = h.api.fetchHistory(true), pages = 0;
  while (true) {
    const request = h.requests.at(-1);
    assert.equal(request.command, 'search_clipboard_history');
    assert.deepEqual(Array.from(request.args.fileExtensions), ['pdf', 'docx']);
    assert.equal(request.args.offset, pages * 37);
    assert.equal(request.args.limit, 38);
    request.resolve(dataset.slice(request.args.offset, request.args.offset + request.args.limit));
    await pending;
    pages++;
    if (!h.state.more) break;
    assert.ok(pages < 20);
    pending = h.api.loadMoreHistory();
  }
  assert.equal(h.state.history.length, 261);
  assert.equal(h.state.offset, 261);
  assert.equal(h.state.request.limited, false);
}
{
  const h = harness('report', {fileExtensions:['pdf']});
  let pending = h.api.fetchHistory(true);
  h.requests.at(-1).resolve([entry(0), entry(0), entry(2)]); await pending;
  assert.equal(h.state.offset, 2);
  pending = h.api.loadMoreHistory();
  assert.equal(h.requests.at(-1).args.offset, 2);
  h.requests.at(-1).reject(new Error('temporary')); await pending;
  pending = h.api.retryHistory();
  assert.equal(h.requests.at(-1).args.offset, 2);
  h.requests.at(-1).resolve([entry(4)]); await pending;
  assert.equal(h.state.request.phase, 'ready');
}
console.log('PASS: 261 file-format results with keyword/tag filters, lookahead, transient offsets and page retry');
