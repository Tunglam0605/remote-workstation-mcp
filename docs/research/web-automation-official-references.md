# Web Automation Official Reference Notes

Status: Phase A evidence
Date: 2026-09-24

## Sources reviewed

- Microsoft Playwright:
  - https://playwright.dev/docs/locators
  - https://playwright.dev/docs/actionability
  - https://playwright.dev/docs/api/class-browsertype
  - https://playwright.dev/docs/api/class-browsercontext
  - https://playwright.dev/docs/api/class-page
  - https://playwright.dev/docs/downloads
  - https://playwright.dev/docs/auth
- Chrome DevTools Protocol:
  - https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/
  - https://chromedevtools.github.io/devtools-protocol/tot/Target/
- Chrome security / extensions:
  - https://developer.chrome.com/blog/remote-debugging-port
  - https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
  - https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
- W3C:
  - https://www.w3.org/TR/webdriver-bidi/
  - https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/

## Findings applied to RWMCP

1. Prefer user-facing semantic locators. Playwright recommends role/name, label and other user-facing locators, with built-in actionability checks and retry behavior.
2. Managed browser contexts are the primary isolation primitive. Persistent contexts use a dedicated user-data directory; the default user's Chrome profile must not be automated.
3. Authentication material is sensitive. RWMCP must never expose cookies/storage state or credentials through MCP responses, logs or repository files.
4. Chrome 136+ intentionally restricts remote debugging of the default profile. Existing-browser integration must therefore be explicit, local and consented; a generic exposed debugging port is rejected.
5. CDP Accessibility and Target domains are useful implementation primitives, but raw CDP commands are not an MCP API.
6. WebDriver BiDi is a standards-track bidirectional browser protocol and remains a future provider option; it is not required for the first production provider.
7. Download handling must await the browser download event and explicitly persist the artifact before context close.
8. Accessibility semantics are role/name/state oriented. RWMCP element identity should therefore be semantic and short-lived, not coordinate based.

## Environment verification

- Production baseline at research time: RWMCP v0.35.0, Action Schema 14, Engineering API 5.
- Windows production node has Google Chrome 153 and Microsoft Edge 153.
- Ubuntu Personal and Ubuntu Vision have no Chrome/Chromium binary in PATH at research time.
- The repository has no Playwright dependency before this phase.

## Consequence

Phase B will implement a Playwright-backed managed-browser provider with Windows live acceptance first, while keeping provider availability explicit on nodes without a supported browser. No system browser installation is part of Phase B.
