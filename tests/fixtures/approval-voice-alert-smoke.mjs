import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const extension = path.join(root, 'assets', 'chatgpt-approval-voice-alert');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const executablePath = chromium.executablePath();
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'rwmcp-voice-probe-'));
let browser;

try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath,
    channel: 'chromium',
    headless: true,
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 20000 });
  if (!worker.url().startsWith('chrome-extension://')) throw new Error('RWMCP approval extension worker did not load');

  const tab = await browser.newPage();
  const url = 'https://chatgpt.com/__rwmcp_local_voice_probe__';
  const fakePrompt = '<!doctype html><html><body><main><h1>Isolated approval fixture</h1>' +
    '<div role="dialog" aria-modal="true" style="display:block;width:400px;height:150px;padding:15px">' +
    '<p>ChatGPT requests permission to use Remote Workstation MCP tool</p>' +
    '<button>Deny</button><button>Allow</button><button>Always Allow</button></div></main></body></html>';
  await tab.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: fakePrompt }));
  await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  let timestamp;
  for (let index = 0; index < 40; index++) {
    timestamp = await worker.evaluate(async () => (await chrome.storage.local.get('lastDetectedAt')).lastDetectedAt);
    if (Number(timestamp) > 0) break;
    await tab.waitForTimeout(200);
  }
  if (!(Number(timestamp) > 0)) throw new Error('Content script did not signal the synthetic Allow modal');
  console.log('PASS: isolated Chrome extension detects allowed-origin visible tool approval; timestamp only=' + timestamp);

  const voiceState = await worker.evaluate(async () => {
    try {
      const voices = await chrome.tts.getVoices();
      return { total: voices.length, vietnamese: voices.some(v => /^vi([-_]|$)/i.test(v.lang || '')) };
    } catch (error) { return { error: String(error && error.message || error) }; }
  });
  console.log('Isolated Chromium TTS voices: ' + JSON.stringify(voiceState));
  const extensionId = new URL(worker.url()).host;
  const popup = await browser.newPage();
  await popup.goto('chrome-extension://' + extensionId + '/popup.html');
  if (!(await popup.locator('#enabled').count()) || !(await popup.locator('#test').count())) {
    throw new Error('Extension popup settings missing');
  }
  console.log('PASS: extension popup loads in isolated Chromium (enabled / volume / test button)');
  console.log('LIMIT: synthetic modal only. Owner Chrome live ChatGPT Allow and spoken audio require separate human acceptance.');
} finally {
  if (browser) await browser.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
