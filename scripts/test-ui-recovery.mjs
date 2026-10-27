// Run: node scripts/test-ui-recovery.mjs
// Exercise the real React entry point with a child that fails during rendering.
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import React, { useState } from 'react';
export default function RenderFailureFixture() {
  const [failed, setFailed] = useState(false);
  if (failed || new URLSearchParams(location.search).has('failOnMount')) {
    throw new TypeError('private-clipboard-content-must-not-be-recorded');
  }
  return <button onClick={() => setFailed(true)}>Trigger render failure</button>;
}`;
const server = await createServer({
  configFile: false,
  root,
  logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-dev-runtime'] },
  plugins: [{
    name: 'render-failure-fixture',
    enforce: 'pre',
    load(id) {
      const path = id.replaceAll('\\', '/');
      if (path.endsWith('/src/App.tsx')
        || path.endsWith('/components/CompactPreviewWindow.tsx')
        || path.endsWith('/components/AdvancedSettingsWindow.tsx')) return fixture;
    }
  }, react()],
  server: { host: '127.0.0.1', port: 5179, watch: { ignored: ['**/src-tauri/**'] } }
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 352, height: 380 } });
  await page.addInitScript(() => {
    const params = new URLSearchParams(location.search);
    window.__readyCalls = [];
    window.__unhandled = 0;
    window.addEventListener('unhandledrejection', () => window.__unhandled++);
    if (params.has('blockedStorage')) {
      Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
    }
    window.__TAURI_INTERNALS__ = {
      invoke(command) {
        window.__readyCalls.push({ command, hasContent: Boolean(document.querySelector('#root')?.textContent) });
        const reject = params.has('rejectReady') || window.__readyCalls.length <= Number(params.get('rejectCount') || 0);
        return reject ? Promise.reject(new Error('IPC unavailable')) : Promise.resolve();
      }
    };
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());

  for (const query of ['', '?window=compact-preview', '?window=advanced-settings']) {
    await page.goto(origin + '/' + query);
    await page.getByRole('button', { name: 'Trigger render failure' }).waitFor();
    if (!query) await page.waitForFunction(() => window.__readyCalls.length > 0);
    const readyCalls = await page.evaluate(() => window.__readyCalls);
    if (query) {
      assert.equal(readyCalls.length, 0, 'Secondary windows must not reveal the main window');
    } else {
      assert.ok(readyCalls.length > 0, 'Main window must notify the backend after rendering');
      assert.ok(readyCalls.every(call => call.command === 'main_window_ready' && call.hasContent));
    }
    await page.evaluate(() => localStorage.setItem('recovery-test-saved-setting', 'keep'));
    await page.getByRole('button', { name: 'Trigger render failure' }).click();
    await page.waitForTimeout(100);
    const hasRecovery = await page.getByRole('button', { name: '重新加载界面' }).count();
    assert.equal(hasRecovery, 1, `Render failure must show a recovery screen (${query || 'main'}); empty roots are not recoverable`);
    const appearance = await page.locator('.app-recovery').evaluate(node => {
      const style = getComputedStyle(node);
      return { background: style.backgroundColor, opacity: style.opacity, height: node.getBoundingClientRect().height };
    });
    assert.match(appearance.background, /^rgb\(/, 'Recovery surface must be opaque');
    assert.equal(appearance.opacity, '1');
    assert.ok(appearance.height >= 300, 'Recovery content must fill the empty window');
    assert.ok(!(await page.locator('body').textContent()).includes('private-clipboard-content'));
    const diagnostic = await page.evaluate(() => localStorage.getItem('tiez_last_render_error'));
    assert.ok(diagnostic && !diagnostic.includes('private-clipboard-content'), 'Persist only safe diagnostic metadata');
    await page.getByRole('button', { name: '重新加载界面' }).click();
    await page.getByRole('button', { name: 'Trigger render failure' }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('recovery-test-saved-setting')), 'keep');
  }

  await page.goto(origin + '/?failOnMount');
  await page.getByRole('button', { name: '重新加载界面' }).waitFor();
  assert.ok((await page.evaluate(() => window.__readyCalls)).every(call => call.hasContent), 'Recovery content must also be committed before the window is shown');
  await page.waitForTimeout(200);
  assert.equal(new URL(page.url()).search, '?failOnMount', 'Persistent faults must not enter an automatic reload loop');
  await page.goto(origin + '/?failOnMount&blockedStorage&rejectReady');
  await page.getByRole('button', { name: '重新加载界面' }).waitFor();
  await page.waitForFunction(() => window.__readyCalls.length >= 3);
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.__readyCalls.length), 3, 'StrictMode replay must not create extra IPC retry loops');
  assert.equal(await page.evaluate(() => window.__unhandled), 0, 'Failed readiness IPC and unavailable storage must leave recovery usable');

  await page.goto(origin + '/?rejectCount=2');
  await page.waitForFunction(() => window.__readyCalls.length === 3);
  assert.equal(await page.evaluate(() => window.__unhandled), 0, 'Transient readiness failures must recover');

  let blockEntry = true;
  await page.route('**/src/main.tsx', route => blockEntry ? route.abort() : route.continue());
  await page.goto(origin + '/');
  await page.locator('#startup-fallback').waitFor();
  assert.equal(await page.locator('#startup-message').textContent(), '界面未能完成加载，可以重新加载重试。');
  assert.match(await page.locator('#startup-fallback').evaluate(node => getComputedStyle(node).backgroundColor), /^rgb\(/);
  assert.equal(await page.evaluate(() => window.__readyCalls.length), 0, 'Static fallback must work before the application module loads');
  blockEntry = false;
  await page.getByRole('button', { name: '重新加载界面' }).click();
  await page.getByRole('button', { name: 'Trigger render failure' }).waitFor();
  assert.equal(await page.locator('#startup-fallback').count(), 0, 'React must replace the startup shell');
  assert.equal(await page.evaluate(() => localStorage.getItem('recovery-test-saved-setting')), 'keep');
  console.log('PASS: render containment, opaque recovery, module-load fallback, manual reload, saved settings, privacy and bounded readiness retries');
} finally {
  await browser?.close();
  await server.close();
}
