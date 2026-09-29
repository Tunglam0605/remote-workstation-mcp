import { BrowserCore } from '../web/browser-core.js';
import { PlaywrightBrowserProvider } from '../web/browser-provider.js';
import { ExistingChromeBridgeClient } from '../web/existing-chrome-bridge.js';
import { ExistingChromeSessionService } from '../web/existing-chrome-session.js';
import { NotebookLmAdapter } from '../web/adapters/notebooklm-adapter.js';

export function createWebServices() {
  const browser = new BrowserCore(new PlaywrightBrowserProvider());
  const existingChrome = new ExistingChromeSessionService(new ExistingChromeBridgeClient());
  const notebooklm = new NotebookLmAdapter(existingChrome);

  return { browser, existingChrome, notebooklm };
}

export type WebServices = ReturnType<typeof createWebServices>;
