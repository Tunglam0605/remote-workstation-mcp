# ADR-WEB-009: Existing Chrome Bridge

Status: Accepted and active
Date: 2026-09-24

## Context

Managed Playwright Chrome is the preferred automation provider for non-authenticated and dedicated-profile workflows, but Google Account sign-in may reject browsers that are controlled by automation software. During live NotebookLM acceptance Google returned `Couldn't sign you in / This browser or app may not be secure` from the managed browser.

Google Account Help explicitly documents that sign-in may be blocked when a browser is controlled through software automation. RWMCP will not attempt to disguise automation, remove automation indicators, replay credentials, copy cookies/tokens, or weaken Google security controls.

## Decision

NotebookLM authentication uses the owner's normal supported Chrome session. RWMCP integrates with that already-authenticated browser through an owner-installed Manifest V3 extension and an authenticated local bridge.

Architecture:

1. owner signs into Google/NotebookLM normally in Chrome;
2. the RWMCP extension is visibly installed by the owner and is limited to NotebookLM origins;
3. the extension service worker connects to an RWMCP Native Messaging host whose manifest allows exactly the stable RWMCP extension origin;
4. the native host exposes an authenticated local named-pipe bridge to the RWMCP process;
5. the RWMCP Existing Chrome session is exclusively owned by one principal + Work Session at a time;
6. content-script messages are treated as untrusted and validated in the extension service worker before native forwarding;
7. password inputs, cookies, storage state, tokens, raw JavaScript/selectors/CDP and coordinate input are not exposed.

The Native Messaging bridge is local-only and does not open a Chrome debugging port on LAN/public interfaces.

## Security boundary

- Exact extension origin is pinned in the Native Messaging host manifest.
- Native host independently validates the extension origin passed by Chrome.
- RWMCP/native-host IPC uses a random local bridge token plus named pipe.
- Only NotebookLM tabs are eligible.
- Existing Chrome tab claims are principal + Work Session owned and participate in lifecycle resource blocking.
- The extension cannot inspect or fill password inputs.
- Existing Chrome does not grant RWMCP access to the user's general browsing tabs.

## Rejected

- retrying Google login inside an automation-controlled browser;
- hiding automation indicators or using stealth/evasion techniques;
- copying authenticated cookies/tokens from the user's browser into Playwright;
- silently attaching to the normal Chrome profile;
- opening `--remote-debugging-port` on a network interface;
- using an existing authenticated browser without owner-visible consent.
