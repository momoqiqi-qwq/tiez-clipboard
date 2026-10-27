// Run: node scripts/test-tag-experience.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React}
}).outputText;
const exports = {};
vm.runInNewContext(compile('../src/shared/lib/tagOptions.ts'), {exports});
const tags = ['Work', '工作', 'Équipe', '项目:研发', 'Work', '', '   ', '100%_完成'];
const original = [...tags];
const filter = query => Array.from(exports.filterTagOptions(tags, query).visible);
assert.deepEqual(filter(' WORK '), ['Work']);
assert.deepEqual(filter('工作'), ['工作']);
assert.deepEqual(filter('éQ'), ['Équipe']);
assert.deepEqual(filter(':'), ['项目:研发']);
assert.deepEqual(filter('%_'), ['100%_完成']);
assert.deepEqual(filter('missing'), []);
assert.deepEqual(filter('   '), ['Work', '工作', 'Équipe', '项目:研发', '100%_完成']);
assert.deepEqual(tags, original, 'Option filtering must not mutate source tags');

let memo;
const viewport = {innerWidth: 500, innerHeight: 700};
const scroll = {};
vm.runInNewContext(compile('../src/shared/hooks/useListScrollMemory.ts'), {
  exports: scroll, window: viewport,
  require: () => ({
    useMemo: (fn, deps) => {
      if (!memo || deps.some((dep, i) => !Object.is(dep, memo.deps[i]))) memo = {deps, value: fn()};
      return memo.value;
    },
    useCallback: fn => fn
  })
});
let items = [{id:1}], settings = {};
const render = (key = 'tag:Work') => scroll.useListScrollMemory(items, key, settings);
let api = render();
assert.equal(api.restoreState, undefined);
const snapshot = {ranges: [], scrollTop: 720};
api.remember(snapshot);
api = render(); assert.strictEqual(api.restoreState, snapshot, 'Same list survives view switch');
const oldRemember = api.remember;
api = render('tag:Other'); assert.equal(api.restoreState, undefined);
oldRemember(snapshot);
assert.equal(render('tag:Other').restoreState, undefined, 'A late old callback must not populate a new cache');
api = render(); api.remember(snapshot);
items = [...items]; assert.equal(render().restoreState, undefined, 'Changed data invalidates measurements');
api = render(); api.remember(snapshot);
settings = {}; assert.equal(render().restoreState, undefined, 'Changed layout settings invalidate measurements');
api = render(); api.remember(snapshot);
viewport.innerWidth = 350; assert.equal(render().restoreState, undefined, 'Changed viewport invalidates measurements');

// Exercise the actual component handlers, including StrictMode effect replay.
const refs = [], effects = [], calls = [];
let refIndex = 0;
const react = {
  forwardRef: fn => fn,
  createElement: (type, props, ...children) => ({type, props: {...props, children}}),
  useRef: initial => refs[refIndex++] ||= {current: initial},
  useImperativeHandle: () => {},
  useCallback: fn => fn,
  useMemo: fn => fn(),
  useEffect: fn => effects.push(fn)
};
const component = {};
vm.runInNewContext(compile('../src/features/clipboard/components/VirtualClipboardList.tsx'), {
  exports: component,
  require: name => name === 'react' ? {...react, default: react} : {Virtuoso: 'Virtuoso'}
});
let saved;
const props = {items: [], renderItem: () => null, selectedIndex: 0, isKeyboardMode: true,
  restoreStateFrom: snapshot, onStateChange: value => saved = value};
const tree = component.VirtualClipboardList(props, null);
refs[0].current = {getState: cb => cb({ranges: [], scrollTop: 0}), scrollToIndex: args => calls.push(args)};
effects.forEach(fn => {fn(); fn();});
assert.equal(calls.length, 0, 'StrictMode replay must not recenter an unchanged restored selection');
tree.props.children[0].props.onScroll({currentTarget: {scrollTop: 1700}});
assert.equal(saved.scrollTop, 1700, 'Use DOM offset rather than lagging Virtuoso state');
refIndex = 0; effects.length = 0;
component.VirtualClipboardList({...props, selectedIndex: 1}, null);
effects.forEach(fn => fn());
assert.equal(calls.at(-1).index, 1, 'A new keyboard selection must still scroll');
console.log('PASS: actual scroll handler offset, StrictMode restoration and subsequent keyboard navigation');
console.log('PASS: independent literal tag search, Unicode/case/whitespace, deduplication, same-list restoration and stale snapshot invalidation');
