// Run: node scripts/test-keyboard-navigation.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/shared/hooks/useKeyboardNavigation.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;

function harness() {
  const exports = {}, listeners = new Map(), effects = [], invocations = [], copies = [], selections = [], modes = [];
  let blurCount = 0;
  vm.runInNewContext(code, {
    exports, console, setTimeout() {},
    window: { addEventListener: (name, handler) => listeners.set(name, handler), removeEventListener: name => listeners.delete(name) },
    require(name) {
      if (name === 'react') return { useRef: value => ({ current: value }), useEffect: effect => effects.push(effect) };
      if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => invocations.push({ command, args }) };
      if (name === '@tauri-apps/api/event') return { listen: async () => () => {} };
      if (name === '@tauri-apps/api/window') return { getCurrentWindow: () => ({ isVisible: async () => true }) };
      if (name === './useWindowVisibility') return { useWindowVisibility: () => ({ current: true }) };
      if (name === './useHotkeyMatching') return { matchesHotkey: () => false };
      throw new Error(`Unexpected import: ${name}`);
    }
  });
  exports.useKeyboardNavigation({
    filteredHistory: [{ id: 1, content: 'clipboard item', content_type: 'text' }, { id: 2 }],
    selectedIndex: 0, isKeyboardMode: true,
    setSelectedIndex: value => selections.push(typeof value === 'function' ? value(0) : value),
    setIsKeyboardMode: value => modes.push(typeof value === 'function' ? value(true) : value),
    showSettings: false, showTagManager: false, chatMode: false, editingTagsId: null,
    arrowKeySelection: true, richPasteHotkey: '',
    searchInputRef: { current: { blur: () => blurCount++ } },
    copyToClipboard: async (...args) => copies.push(args), setSearch() {}
  });
  const cleanups = effects.map(effect => effect());
  return { invocations, copies, selections, modes, get blurCount() { return blurCount; },
    keydown: event => listeners.get('keydown')(event),
    cleanup: () => cleanups.forEach(cleanup => cleanup?.()) };
}
function keyEvent(key, targetName = 'INPUT', composition = {}) {
  return { key, isComposing: false, keyCode: 0, ...composition,
    target: { tagName: targetName, closest: () => null, classList: { contains: name => targetName === 'INPUT' && name === 'search-input' } },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  for (const key of ['Escape', 'Enter', 'ArrowUp', 'ArrowDown']) {
    for (const target of ['INPUT', 'DIV']) {
      const h = harness(), event = keyEvent(key, target, composition);
      await h.keydown(event);
      assert.equal(h.blurCount, 0, `IME ${key} must not blur the search box`);
      assert.equal(h.invocations.filter(call => call.command === 'hide_window_cmd').length, 0, `IME ${key} must not hide the window`);
      assert.equal(h.copies.length, 0, `IME ${key} must not paste clipboard content`);
      assert.equal(h.selections.length, 0, `IME ${key} must not navigate the list`);
      assert.equal(event.prevented, false, 'IME retains the keyboard event');
      assert.equal(event.stopped, false, 'IME retains event propagation');
      h.cleanup();
    }
  }
}
{
  const h = harness(); await h.keydown(keyEvent('Escape'));
  assert.equal(h.blurCount, 1, 'Normal Escape still leaves search input'); h.cleanup();
}
{
  const h = harness(); await h.keydown(keyEvent('Escape', 'DIV'));
  assert.equal(h.invocations.filter(call => call.command === 'hide_window_cmd').length, 1, 'Normal Escape still hides a top-level panel'); h.cleanup();
}
{
  const h = harness(); await h.keydown(keyEvent('Enter'));
  assert.equal(h.copies.length, 1, 'Normal Enter still pastes the keyboard selection'); h.cleanup();
}
{
  const h = harness(); await h.keydown(keyEvent('ArrowDown'));
  assert.deepEqual(h.selections, [1], 'Normal arrows still navigate'); h.cleanup();
}
console.log('PASS: IME keys cannot hide/blur/paste/navigate; ordinary Escape, Enter and arrows retain their behavior');

for (const key of ['Escape', 'Enter', 'ArrowUp', 'ArrowDown']) {
  const h = harness(), event = keyEvent(key, 'BUTTON');
  event.target.closest = () => ({});
  await h.keydown(event);
  assert.equal(h.copies.length, 0);
  assert.equal(h.selections.length, 0);
  assert.equal(h.invocations.filter(call => call.command === 'hide_window_cmd').length, 0);
  assert.equal(event.prevented, false, 'Category dialog owns its keyboard events');
  h.cleanup();
}
console.log('PASS: category dialog cannot paste, navigate clipboard history or hide the app');
