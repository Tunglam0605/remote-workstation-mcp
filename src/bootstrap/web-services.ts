import { BrowserCore } from '../web/browser-core.js';
import { PlaywrightBrowserProvider } from '../web/browser-provider.js';
import { ExistingChromeBridgeClient } from '../web/existing-chrome-bridge.js';
import { ExistingChromeSessionService } from '../web/existing-chrome-session.js';
import { NotebookLmAdapter } from '../web/adapters/notebooklm-adapter.js';
import type { SetupSettings } from '../setup/settings.js';
import { createBrowserDomainPolicy } from '../web/domain-policy.js';

export function createWebServices(settings: Pick<SetupSettings, 'browser' | 'social'>) {
  const browser = new BrowserCore(
    new PlaywrightBrowserProvider(),
    createBrowserDomainPolicy(settings),
    undefined,
    undefined,
    {
      maxFileBytes: settings.browser.maxUploadFileBytes,
      maxBatchBytes: settings.browser.maxUploadBatchBytes
    }
  );
  const existingChrome = new ExistingChromeSessionService(new ExistingChromeBridgeClient());
  const notebooklm = new NotebookLmAdapter(existingChrome);

  return { browser, existingChrome, notebooklm };
}

export type WebServices = ReturnType<typeof createWebServices>;
