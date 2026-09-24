# ADR-WEB-007: Upload and Download Architecture

Status: Accepted for architecture; implementation deferred to Phase D
Date: 2026-09-24

## Upload

Use browser/file-input semantics such as Playwright `setInputFiles`. Paths must resolve through authorized RWMCP workspace policy, with bounded count/size/MIME checks. Do not fake drag/drop with physical input when a file input or supported browser API exists.

## Download

Capture the browser download event before the triggering action, persist only to an RWMCP-controlled artifact/download directory, then return bounded metadata:
- filename;
- size;
- MIME when known;
- SHA-256;
- controlled path;
- source domain.

Browser temporary download paths are not durable evidence.

## Security

No arbitrary destination path supplied directly to the browser. Downloads and uploads remain Work Session attributable and auditable.
