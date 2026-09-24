# ADR-WEB-010: Visual and Desktop Fallback

Status: Accepted as deferred architecture
Date: 2026-09-24

## Decision

Visual understanding and physical input are separate capabilities and permissions.

Fallback order:
1. semantic DOM/accessibility;
2. stable provider/CDP operation;
3. visual screenshot interpretation;
4. physical mouse/keyboard.

Visual fallback does not imply permission to move the mouse or send keyboard events.

Physical input is a separate future Desktop Control capability, OFF by default, used only when no reliable semantic interface exists. It must never be required for the managed-browser production baseline.

## Consequence

Phase B contains no physical input implementation and no coordinate action API.
