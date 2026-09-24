# ADR-WEB-003: Browser Profile and Authentication

Status: Accepted for Phase A; persistent profile implementation deferred to Phase E
Date: 2026-09-24

## Decision

RWMCP never automates the user's default Chrome profile.

Persistent automation will use dedicated RWMCP-owned profile directories. The user may log in manually once in a visible managed browser. RWMCP may report coarse profile/authentication state but must never read or return passwords, OAuth refresh tokens, cookie values, browser password databases or storage-state secrets.

Phase B uses ephemeral managed contexts only. Persistent profile creation, restart survival and auth-state acceptance are Phase E.

## Security rationale

Chrome 136+ deliberately requires a non-default user-data directory for remote debugging. Playwright also warns against automating the normal Chrome profile.

## Rejected

- Copying the user's Chrome profile.
- Exporting cookies/storage state through MCP.
- Saving auth material inside the repository.
