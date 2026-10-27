// Run: node scripts/test-search-query.mjs
// Deterministic timer/dependency harness for immediate filter actions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/shared/hooks/useSearchQuery.ts', import.meta.url), 'utf8');
const slots = [], effects = [], timers = new Map();
let cursor = 0, timerId = 0, value = '', api;
const setValue = next => { value = next; };
const exports = {};
vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {
  exports,
  setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: id => timers.delete(id),
  require: () => ({
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
      return [slots[index], next => { slots[index] = next; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= {current: initial}; },
    useCallback: fn => fn,
    useEffect(fn, deps) { const index = cursor++, previous = effects[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        previous?.cleanup?.(); effects[index] = {deps, cleanup: fn()};
      }
    }
  })
});
const render = () => { cursor = 0; api = exports.useSearchQuery(value, setValue); };
const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); render(); };
render();
value = 'old text'; render();
assert.equal(api.query, '', 'Text entry stays debounced');
api.commit('tag:工作'); render();
assert.equal(value, 'tag:工作');
assert.equal(api.query, 'tag:工作', 'Explicit selection commits without waiting for a timer');
flush(); assert.equal(api.query, 'tag:工作', 'Cancelled old timer cannot restore old text');
value = 'new text'; render();
assert.equal(api.query, 'tag:工作', 'Typing after a selection must not revert to an older query');
flush(); assert.equal(api.query, 'new text');
api.commit(''); render(); assert.equal(api.query, '');
value = 'pending'; render();
for (const effect of effects) effect?.cleanup?.();
assert.equal(timers.size, 0, 'Unmount cancels pending queries');
console.log('PASS: debounce, instant tag selection, stale timer cancellation, clear-all and cleanup');
