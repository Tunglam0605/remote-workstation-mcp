import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Browser, BrowserContext, Locator, Page } from 'playwright-core';

export const SEMANTIC_ROLES = ['heading', 'link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'file'] as const;
export type SemanticRole = typeof SEMANTIC_ROLES[number];

export interface ManagedBrowser {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

export interface BrowserElementCandidate {
  role: SemanticRole;
  name: string;
  ordinal: number;
  visible: boolean;
  enabled: boolean;
}

export interface BrowserElementTarget {
  role: SemanticRole;
  name: string;
  ordinal: number;
}

export type BrowserInteraction =
  | { kind: 'click' }
  | { kind: 'fill'; value: string }
  | { kind: 'type'; text: string; delayMs: number }
  | { kind: 'press'; key: string }
  | { kind: 'select'; value: string }
  | { kind: 'check'; checked: boolean };

export type BrowserWaitCondition =
  | { kind: 'text'; text: string; state: 'visible' | 'hidden' }
  | { kind: 'url'; value: string; match: 'exact' | 'prefix' }
  | { kind: 'element'; role: SemanticRole; name: string; state: 'visible' | 'hidden' | 'enabled' | 'disabled' }
  | { kind: 'load'; state: 'domcontentloaded' | 'load' | 'networkidle' };

export interface BrowserProvider {
  availability(): { available: boolean; executable?: string; reason?: string };
  launch(mode: 'background' | 'visible', profileDir?: string): Promise<ManagedBrowser>;
  openTab(context: BrowserContext): Promise<Page>;
  closeTab(page: Page): Promise<void>;
  navigate(page: Page, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<void>;
  inspect(page: Page, maxItems: number): Promise<BrowserElementCandidate[]>;
  find(page: Page, role: SemanticRole, name: string, maxItems: number): Promise<{ matches: BrowserElementCandidate[]; truncated: boolean }>;
  interact(page: Page, target: BrowserElementTarget, action: BrowserInteraction): Promise<void>;
  upload(page: Page, target: BrowserElementTarget, files: string[]): Promise<void>;
  download(page: Page, target: BrowserElementTarget, timeoutMs: number): Promise<{ suggestedFilename: string; temporaryPath: string }>;
  wait(page: Page, condition: BrowserWaitCondition, timeoutMs: number): Promise<void>;
  extract(page: Page, maxChars: number): Promise<{ text: string; truncated: boolean }>;
  screenshot(page: Page): Promise<Buffer>;
}

async function accessibleName(locator: Locator, fallback = ''): Promise<string> {
  try {
    const snapshot = await locator.ariaSnapshotJSON({ depth: 0, timeout: 1_500 });
    if (Array.isArray(snapshot) && snapshot.length > 0) {
      const first = snapshot[0] as Record<string, unknown>;
      if (typeof first?.name === 'string') return first.name.slice(0, 256);
    }
  } catch {
    // Fall through to bounded DOM-visible metadata.
  }
  const aria = await locator.getAttribute('aria-label').catch(() => null);
  if (aria) return aria.slice(0, 256);
  const placeholder = await locator.getAttribute('placeholder').catch(() => null);
  if (placeholder) return placeholder.slice(0, 256);
  return (await locator.innerText({ timeout: 1_000 }).catch(() => fallback)).slice(0, 256);
}

async function describe(locator: Locator, role: SemanticRole, ordinal: number, fallbackName = ''): Promise<BrowserElementCandidate> {
  const name = await accessibleName(locator, fallbackName);
  return {
    role,
    name,
    ordinal,
    visible: await locator.isVisible().catch(() => false),
    enabled: await locator.isEnabled().catch(() => false)
  };
}

async function resolveExact(page: Page, target: BrowserElementTarget): Promise<Locator> {
  if (target.role === 'file') {
    const inputs = page.locator('input[type="file"]');
    const matches: Locator[] = [];
    for (let index = 0; index < await inputs.count(); index++) {
      const item = inputs.nth(index);
      if ((await accessibleName(item)) === target.name) matches.push(item);
    }
    if (matches.length <= target.ordinal) throw new Error('ELEMENT_STALE: semantic file input no longer resolves.');
    return matches[target.ordinal]!;
  }
  const matches = page.getByRole(target.role, { name: target.name, exact: true });
  const count = await matches.count();
  if (count <= target.ordinal) throw new Error('ELEMENT_STALE: semantic element no longer resolves.');
  return matches.nth(target.ordinal);
}

async function waitForEnabled(locator: Locator, enabled: boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await locator.waitFor({ state: 'visible', timeout: timeoutMs });
  while (Date.now() <= deadline) {
    if ((await locator.isEnabled().catch(() => false)) === enabled) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`WAIT_TIMEOUT: element did not become ${enabled ? 'enabled' : 'disabled'}.`);
}

export class PlaywrightBrowserProvider implements BrowserProvider {
  openTab(context: BrowserContext) { return context.newPage(); }
  async closeTab(page: Page) { await page.close(); }

  async navigate(page: Page, action: 'goto' | 'back' | 'forward' | 'reload', url?: string) {
    const options = { waitUntil: 'domcontentloaded' as const, timeout: 15_000 };
    if (action === 'goto') await page.goto(url!, options);
    else if (action === 'back') await page.goBack(options);
    else if (action === 'forward') await page.goForward(options);
    else await page.reload(options);
  }

  async inspect(page: Page, maxItems: number) {
    const elements: BrowserElementCandidate[] = [];
    const ordinals = new Map<string, number>();
    for (const role of SEMANTIC_ROLES) {
      const locator = role === 'file' ? page.locator('input[type="file"]') : page.getByRole(role);
      const count = Math.min(await locator.count(), maxItems - elements.length);
      for (let index = 0; index < count; index++) {
        const item = locator.nth(index);
        const name = await accessibleName(item);
        const key = `${role}\u0000${name}`;
        const ordinal = ordinals.get(key) ?? 0;
        ordinals.set(key, ordinal + 1);
        elements.push(await describe(item, role, ordinal, name));
      }
      if (elements.length >= maxItems) break;
    }
    return elements;
  }

  async find(page: Page, role: SemanticRole, name: string, maxItems: number) {
    if (role === 'file') {
      const inputs = page.locator('input[type="file"]');
      const matches: BrowserElementCandidate[] = [];
      for (let index = 0; index < await inputs.count() && matches.length < maxItems; index++) {
        const item = inputs.nth(index);
        if ((await accessibleName(item)) === name) matches.push(await describe(item, role, matches.length, name));
      }
      return { matches, truncated: false };
    }
    const locator = page.getByRole(role, { name, exact: true });
    const count = await locator.count();
    const matches: BrowserElementCandidate[] = [];
    for (let ordinal = 0; ordinal < Math.min(count, maxItems); ordinal++) {
      matches.push(await describe(locator.nth(ordinal), role, ordinal, name));
    }
    return { matches, truncated: count > maxItems };
  }

  async interact(page: Page, target: BrowserElementTarget, action: BrowserInteraction) {
    const locator = await resolveExact(page, target);
    const timeout = 10_000;
    if (action.kind === 'click') await locator.click({ timeout });
    else if (action.kind === 'fill') await locator.fill(action.value, { timeout });
    else if (action.kind === 'type') await locator.pressSequentially(action.text, { delay: action.delayMs, timeout });
    else if (action.kind === 'press') await locator.press(action.key, { timeout });
    else if (action.kind === 'select') await locator.selectOption({ value: action.value }, { timeout });
    else if (action.checked) await locator.check({ timeout });
    else await locator.uncheck({ timeout });
  }

  async upload(page: Page, target: BrowserElementTarget, files: string[]) {
    const locator = await resolveExact(page, target);
    await locator.setInputFiles(files, { timeout: 10_000 });
  }

  async download(page: Page, target: BrowserElementTarget, timeoutMs: number) {
    const locator = await resolveExact(page, target);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: timeoutMs }),
      locator.click({ timeout: Math.min(timeoutMs, 10_000) })
    ]);
    const failure = await download.failure();
    if (failure) throw new Error(`DOWNLOAD_FAILED: ${failure}`);
    const temporaryPath = await download.path();
    if (!temporaryPath) throw new Error('DOWNLOAD_FAILED: browser did not expose a completed download path.');
    return { suggestedFilename: download.suggestedFilename().slice(0, 256), temporaryPath };
  }

  async wait(page: Page, condition: BrowserWaitCondition, timeoutMs: number) {
    if (condition.kind === 'text') {
      await page.getByText(condition.text, { exact: false }).first().waitFor({ state: condition.state, timeout: timeoutMs });
      return;
    }
    if (condition.kind === 'url') {
      if (condition.match === 'exact') await page.waitForURL(condition.value, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      else await page.waitForURL(url => url.href.startsWith(condition.value), { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      return;
    }
    if (condition.kind === 'load') {
      await page.waitForLoadState(condition.state, { timeout: timeoutMs });
      return;
    }
    const locator = await resolveExact(page, { role: condition.role, name: condition.name, ordinal: 0 });
    if (condition.state === 'visible' || condition.state === 'hidden') {
      await locator.waitFor({ state: condition.state, timeout: timeoutMs });
      return;
    }
    await waitForEnabled(locator, condition.state === 'enabled', timeoutMs);
  }

  async extract(page: Page, maxChars: number) {
    const text = await page.locator('body').innerText({ timeout: 5_000 });
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  }

  screenshot(page: Page) { return page.screenshot({ type: 'png', fullPage: false, timeout: 10_000, animations: 'disabled' }); }

  availability() {
    if (process.platform !== 'win32') return { available: false, reason: 'Managed Chrome/Edge detection is currently supported on Windows only.' };
    const systemDrive = process.env.SystemDrive ?? 'C:';
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
      path.join(systemDrive, 'Program Files'),
      path.join(systemDrive, 'Program Files (x86)')
    ].filter((root, index, all): root is string => Boolean(root) && all.indexOf(root) === index);
    for (const root of roots) {
      for (const relative of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe']) {
        const executable = path.join(root, relative);
        if (fs.existsSync(executable)) return { available: true, executable };
      }
    }
    return { available: false, reason: 'No managed Chrome or Edge executable was found.' };
  }

  async launch(mode: 'background' | 'visible', profileDir?: string): Promise<ManagedBrowser> {
    const status = this.availability();
    if (!status.available || !status.executable) throw new Error(status.reason ?? 'Browser provider unavailable.');
    const { chromium } = await import('playwright-core');
    if (profileDir) {
      const context = await chromium.launchPersistentContext(profileDir, {
        executablePath: status.executable,
        headless: mode === 'background',
        acceptDownloads: true,
        serviceWorkers: 'block',
        downloadsPath: os.tmpdir()
      });
      const browser = context.browser();
      if (!browser) {
        await context.close().catch(() => {});
        throw new Error('Persistent browser context did not expose its managed browser.');
      }
      context.setDefaultTimeout(10_000);
      const pages = context.pages();
      const page = pages[0] ?? await context.newPage();
      return {
        browser,
        context,
        page,
        close: async () => {
          await context.close().catch(() => {});
        }
      };
    }
    const browser = await chromium.launch({
      executablePath: status.executable,
      headless: mode === 'background',
      downloadsPath: os.tmpdir()
    });
    try {
      const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
      context.setDefaultTimeout(10_000);
      const page = await context.newPage();
      return {
        browser,
        context,
        page,
        close: async () => {
          await context.close().catch(() => {});
          await browser.close().catch(() => {});
        }
      };
    } catch (error) {
      await browser.close();
      throw error;
    }
  }
}
