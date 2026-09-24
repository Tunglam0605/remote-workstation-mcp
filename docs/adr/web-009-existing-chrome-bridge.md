# ADR-WEB-009: Existing Chrome Bridge

Status: Accepted as deferred architecture
Date: 2026-09-24

## Decision

Existing-user-Chrome automation is not part of the managed-browser production baseline.

After managed browser acceptance, evaluate:
1. Chrome's explicit agent/debug consent mechanisms where available;
2. a Chrome Extension using isolated content scripts plus an authenticated local bridge/native messaging;
3. custom-profile loopback CDP only when explicitly owner-started.

Any bridge must be local-only, authenticated, origin-validated and bounded. It must not expose a Chrome debugging endpoint to LAN/public interfaces.

Chrome extension messages from content scripts are treated as untrusted and validated before privileged native actions.

## Rejected

- silently attaching to the normal Chrome profile;
- opening `--remote-debugging-port` on a network interface;
- using an existing authenticated browser without owner-visible consent.
