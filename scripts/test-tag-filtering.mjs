// Run: node scripts/test-tag-filtering.mjs
// Deterministic hook/IPC regression checks, without a desktop runtime.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
{
  const exports = {};
  vm.runInNewContext(compile('../src/shared/lib/historySearch.ts'), { exports });
  for (const query of ['tag:工作', ' TAG:工作 ', ' TaG: 工作  ']) {
    const parsed = exports.parseHistorySearch(query);
    assert.equal(parsed.tagOnly, true);
    assert.equal(parsed.term, '工作');
    assert.equal(parsed.normalizedTerm, '工作');
  }
  assert.equal(exports.parseHistorySearch('tag:项目:研发').term, '项目:研发');
  assert.equal(exports.parseHistorySearch('tag:  ').term, '');
  assert.equal(exports.parseHistorySearch('notag:工作').tagOnly, false);
}
const tagsCode = compile('../src/shared/hooks/useTagList.ts');
function tagsHarness(rejectListeners = false) {
  let state = [], cleanup, writes = 0, unsubscribed = 0;
  const requests = [], listeners = new Map(), errors = [], exports = {};
  vm.runInNewContext(tagsCode, { exports, console: { error: (...args) => errors.push(args) }, require(name) {
    if (name === 'react') return {
      useState: () => [state, next => { state = next; writes++; }],
      useEffect: fn => { cleanup = fn(); }
    };
    if (name === '@tauri-apps/api/core') return {
      invoke: () => new Promise((resolve, reject) => requests.push({ resolve, reject }))
    };
    assert.equal(name, '@tauri-apps/api/event');
    return { listen: (event, fn) => {
      if (rejectListeners) return Promise.reject(new Error('subscription failed'));
      listeners.set(event, fn);
      return Promise.resolve(() => { listeners.delete(event); unsubscribed++; });
    }};
  }});
  exports.useTagList();
  return { requests, listeners, errors, get state() { return state; },
    get writes() { return writes; }, get unsubscribed() { return unsubscribed; },
    unmount: () => cleanup() };
}
{
  const h = tagsHarness();
  h.listeners.get('tags-changed')();
  h.requests[1].resolve({ Work: 4, Personal: 2, '': 9, '  ': 1 }); await flush();
  assert.deepEqual(Array.from(h.state, x => x.name), ['Work', 'Personal']);
  const current = h.state;
  h.requests[0].resolve({ Stale: 99 }); await flush();
  assert.strictEqual(h.state, current);
  for (const invalid of [null, [], 'bad', { Work: '4' }, { Work: -1 }, { Work: 1.5 }]) {
    h.listeners.get('clipboard-updated')(); h.requests.at(-1).resolve(invalid); await flush();
    assert.strictEqual(h.state, current);
  }
  h.listeners.get('clipboard-removed')(); h.requests.at(-1).reject(new Error('offline')); await flush();
  assert.strictEqual(h.state, current);
  h.listeners.get('tags-changed')(); h.requests.at(-1).resolve({}); await flush();
  assert.equal(h.state.length, 0, 'An empty valid map must clear removed tags');
  h.listeners.get('tags-changed')();
  h.unmount(); const writes = h.writes;
  h.requests.at(-1).resolve({ Late: 4 }); await flush();
  assert.equal(h.writes, writes);
  assert.equal(h.unsubscribed, 4);
}
{
  const h = tagsHarness(true);
  h.requests[0].resolve({ Work: 1 }); await flush();
  assert.equal(h.state[0].name, 'Work');
  assert.equal(h.errors.length, 4);
  h.unmount(); await flush();
}
{
  const h = tagsHarness();
  h.listeners.get('tags-changed')();
  h.requests[1].resolve({ New: 1 }); await flush();
  const count = h.writes;
  h.requests[0].reject(new Error('obsolete')); await flush();
  assert.equal(h.writes, count);
  assert.equal(h.errors.length, 0);
  h.unmount(); await flush();
}
// Simulate effect dependency checks over re-renders, including IME composition.
{
  let cursor = 0, fetches = 0;
  const slots = [], exports = {};
  vm.runInNewContext(compile('../src/shared/hooks/useSearchFetchTrigger.ts'), {
    exports, require: () => ({ useEffect: (fn, deps) => {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old[i]))) { slots[index] = deps; fn(); }
    } })
  });
  const options = { debouncedSearch: '', typeFilter: null, isComposing: false,
    fetchHistory: reset => { assert.equal(reset, true); fetches++; } };
  const render = () => { cursor = 0; exports.useSearchFetchTrigger(options); };
  render(); assert.equal(fetches, 1);
  render(); assert.equal(fetches, 1);
  options.debouncedSearch = 'tag:Work'; options.fetchHistory = () => { fetches++; };
  render(); assert.equal(fetches, 2, 'A query and callback change should fetch only once');
  options.typeFilter = 'text'; render(); assert.equal(fetches, 3);
  options.isComposing = true; options.debouncedSearch = 'tag:工'; render(); assert.equal(fetches, 3);
  options.typeFilter = 'image'; render(); assert.equal(fetches, 3);
  options.isComposing = false; render(); assert.equal(fetches, 4);
}
console.log('PASS: tag refresh races, invalid counts, failure preservation, deletion, cleanup, rejected subscriptions, single fetch and IME gating');
