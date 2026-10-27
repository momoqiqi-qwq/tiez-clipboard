// Run: node scripts/test-tag-manager.mjs
// Exercise the real component's input handlers and asynchronous IPC lifecycle.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/features/tag/components/TagManager.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const states = [], refs = [], effects = [], requests = [], subscriptions = [], exports = {};
  let stateCursor = 0, refCursor = 0, effectCursor = 0, unlistened = 0;
  const react = {
    useState(initial) {
      const index = stateCursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef: initial => refs[refCursor++] ||= { current: initial },
    useMemo: fn => fn(),
    useEffect(fn, deps) {
      const index = effectCursor++, previous = effects[index];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects[index] = { deps, fn, cleanup: previous?.cleanup, pending: true };
      }
    }
  };
  vm.runInNewContext(code, {
    exports, console,
    window: {
      localStorage: { getItem: () => null, setItem() {} },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
    },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
      if (name === '@tauri-apps/api/core') return {
        invoke: (command, args) => new Promise((resolve, reject) => requests.push({ command, args, resolve, reject })),
        convertFileSrc: value => value
      };
      if (name === '@tauri-apps/api/event') return {
        emit: async () => {},
        listen: (event, callback) => new Promise(resolve => subscriptions.push({
          event, callback, resolve: () => resolve(() => { unlistened++; })
        }))
      };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, name) => name });
      return { getTagColor: () => '#888888' };
    }
  });
  const render = () => {
    stateCursor = refCursor = effectCursor = 0;
    const tree = exports.default({ t: key => key, theme: 'light' });
    for (const effect of effects) {
      if (effect.pending) { effect.cleanup?.(); effect.cleanup = effect.fn(); effect.pending = false; }
    }
    return tree;
  };
  render();
  return { render, states, requests, subscriptions, get unlistened() { return unlistened; },
    unmount: () => effects.forEach(effect => effect.cleanup?.()),
    pending: command => requests.filter(request => request.command === command),
    async seed() {
      requests.find(request => request.command === 'get_all_tags_info').resolve({ Work: 2, Other: 1 });
      requests.find(request => request.command === 'get_tag_colors').resolve({});
      await flush();
    }
  };
}
function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) { for (const child of node) { const match = find(child, predicate); if (match) return match; } }
  if (node.props) { if (predicate(node)) return node; return find(node.props.children, predicate); }
}
const event = (key, composing = false) => ({ key, nativeEvent: { isComposing: composing, keyCode: composing ? 229 : 13 }, preventDefault() {}, stopPropagation() {} });

{
  const h = harness();
  const input = () => find(h.render(), node => node.props.placeholder === 'find_or_create');
  input().props.onChange({ target: { value: '工作' } });
  input().props.onKeyDown(event('Enter', true));
  assert.equal(h.pending('create_new_tag').length, 0, 'IME confirmation must not create a partial tag');
  input().props.onKeyDown(event('Enter'));
  assert.equal(h.pending('create_new_tag').length, 1, 'Normal Enter still creates a tag');
  assert.equal(h.pending('create_new_tag')[0].args.tagName, '工作');
  h.unmount();
}
{
  const h = harness(); await h.seed();
  find(h.render(), node => node.props.title === '重命名').props.onClick(event(''));
  const input = () => find(h.render(), node => node.props.className === 'inline-tag-edit');
  input().props.onChange({ target: { value: '工作' } });
  input().props.onKeyDown(event('Enter', true));
  assert.equal(h.pending('rename_tag_globally').length, 0, 'IME confirmation must not rename a tag');
  h.unmount();
}
{
  const h = harness(); await h.seed();
  find(h.render(), node => node.props.title === 'Other' && node.props.className?.includes('tag-item')).props.onClick();
  const requests = h.pending('get_tag_items');
  assert.deepEqual(requests.map(request => request.args.tag), ['Work', 'Other']);
  requests[1].resolve([{ id: 2, content: 'Other content', content_type: 'text', timestamp: 0 }]); await flush();
  requests[0].resolve([{ id: 1, content: 'Stale Work content', content_type: 'text', timestamp: 0 }]); await flush();
  const itemState = h.states.find(value => Array.isArray(value) && value[0]?.content);
  assert.equal(itemState[0].id, 2, 'Late response must not overwrite the selected tag contents');
  h.unmount();
}
{
  const h = harness();
  h.unmount();
  // Registering an IPC listener can finish after the component was unmounted.
  for (const subscription of h.subscriptions) subscription.resolve();
  await flush();
  assert.equal(h.unlistened, h.subscriptions.length, 'Every late listener must be cleaned up');
  const requestCount = h.requests.length;
  h.subscriptions.forEach(subscription => subscription.callback());
  assert.equal(h.requests.length, requestCount, 'Late callbacks must not issue IPC after unmount');
}
{
  const h = harness(); await h.seed();
  h.subscriptions.find(subscription => subscription.event === 'tags-changed').callback();
  h.pending('get_all_tags_info')[1].resolve({});
  h.pending('get_tag_colors')[1].resolve({});
  await flush();
  h.pending('get_tag_items')[0].resolve([{ id: 1, content: 'Deleted tag content', content_type: 'text', timestamp: 0 }]); await flush();
  assert.equal(find(h.render(), node => node.props.className === 'status-msg').props.children, 'select_tag_to_begin',
    'Deleting all tags must invalidate the old contents request');
  h.unmount();
}
{
  const h = harness(); await h.seed();
  h.pending('get_tag_items')[0].resolve([{ id: 1, content: 'Work content', content_type: 'text', timestamp: 0 }]); await flush();
  find(h.render(), node => node.props.className?.includes('manage-btn')).props.onClick();
  find(h.render(), node => node.props.className?.startsWith('themed-card')).props.onClick();
  assert.equal(find(h.render(), node => node.props.className === 'sort-btn danger').props.disabled, false);
  find(h.render(), node => node.props.title === 'Other' && node.props.className?.includes('tag-item')).props.onClick();
  assert.equal(find(h.render(), node => node.props.className === 'sort-btn danger').props.disabled, true,
    'Switching tags must clear hidden selections before bulk delete');
  h.unmount();
}

// Extract and execute the card's real tag-input handler without starting hover previews.
const cardSource = ts.createSourceFile('ClipboardItem.tsx', readFileSync(new URL('../src/features/clipboard/components/ClipboardItem.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerSource;
function visit(node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(cardSource) === 'input') {
    const attributes = node.attributes.properties;
    if (attributes.some(attribute => attribute.name?.getText(cardSource) === 'className' && attribute.initializer?.text === 'tag-input')) {
      handlerSource = attributes.find(attribute => attribute.name?.getText(cardSource) === 'onKeyDown').initializer.expression.getText(cardSource);
    }
  }
  ts.forEachChild(node, visit);
}
visit(cardSource); assert.ok(handlerSource);
for (const key of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
  let calls = 0;
  const context = {
    exports: {}, isComposing: { current: false }, pickableTagSuggestions: ['Work'], tagSuggestIndex: -1,
    onTagPick: () => calls++, onTagAdd: () => calls++, onTagEditCancel: () => calls++,
    setTagSuggestIndex: () => calls++, setLocalTagInput: () => calls++
  };
  vm.runInNewContext(ts.transpile(`exports.handler = ${handlerSource};`), context);
  context.exports.handler({ ...event(key), nativeEvent: { isComposing: true, keyCode: 0 } });
  context.exports.handler({ ...event(key), nativeEvent: { isComposing: false, keyCode: 229 } });
  context.isComposing.current = true;
  context.exports.handler(event(key));
  assert.equal(calls, 0, `IME ${key} must remain under the input method's control`);
  if (key === 'Enter') {
    context.isComposing.current = false;
    context.exports.handler(event(key));
    assert.equal(calls, 1, 'Normal Enter must still submit the card tag');
  }
}
console.log('PASS: tag creation/rename IME protection, selected-tag response ordering and late listener cleanup');
console.log('PASS: tag-switch bulk selection reset and clipboard-card IME navigation protection');
