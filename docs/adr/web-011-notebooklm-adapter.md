# ADR-WEB-011: NotebookLM Adapter v1

Status: Accepted and implemented
Date: 2026-09-24

## Context

NotebookLM requires an authenticated Google session. Google may reject sign-in from software-controlled browsers, so authentication is preserved in the owner's normal Chrome session through the Existing Chrome Bridge defined by ADR-WEB-009.

The site adapter must remain above the generic browser/bridge layers. Site-specific wording, postconditions and workflow semantics must not leak into BrowserCore or Native Messaging transport.

## Decision

NotebookLM Adapter v1 exposes only operations with meaningful, verified postconditions:

- `notebooklm_session_open`: claim one already-authenticated notebook tab and verify a real `/notebook/<id>` page;
- `notebooklm_session_status`: bounded notebook id/title/url/source count;
- `notebooklm_session_close`: release the Work Session claim without closing the owner's Chrome tab;
- `notebooklm_sources_list`: semantic source inventory with count/truncation evidence;
- `notebooklm_ask`: fill the semantic query box, activate Send and wait until the conversation changed, NotebookLM busy markers disappeared, and page text became stable.

The adapter supports Vietnamese and English query/send labels used by NotebookLM. It never accepts raw selectors, JavaScript or coordinates.

## Postconditions

A click or fill is never treated as operation success by itself.

- Open succeeds only when authenticated notebook metadata can be read.
- Source listing reconciles semantic source checkboxes with the notebook source count.
- Ask succeeds only when the submitted question is observed in changed conversation state, generation is no longer busy, and the page reaches a stable state.

## Deferred

- Local file upload through Existing Chrome: browser security prevents safely setting file paths from a content script. Managed Browser file-I/O remains the typed upload path.
- Web/text source creation: semantic discovery is known but mutation is deferred until a dedicated acceptance case verifies source inventory postconditions.
- Studio generation (audio/video/presentation/mind-map/report/etc.): deferred until each artifact workflow has a deterministic completion postcondition.
- Google login, 2FA, CAPTCHA and credential entry remain owner actions.

## Security

NotebookLM Adapter inherits Existing Chrome principal + Work Session ownership. It does not expose password inputs, cookies, browser storage, Google tokens, Chrome debugger APIs, raw DOM selectors or LAN debugging endpoints.
