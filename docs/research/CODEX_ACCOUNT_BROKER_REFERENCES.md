# Codex Account Broker authoritative/upstream reference review

This record documents why RWMCP v0.25 interoperates with Cockpit Tools as an external account-pool provider instead of copying its credential-management implementation or rewriting Codex authentication files.

## Source priority

1. OpenAI Codex upstream provider/config implementation.
2. Cockpit Tools upstream repository, release notes and API-service documentation.
3. Local installed Cockpit configuration and real runtime behavior.
4. Community multi-account projects only as design inspiration, never as authority for authentication semantics.

## OpenAI Codex custom model providers

Sources:
- https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs
- https://github.com/openai/codex/issues/2760

Relevant evidence:
- Codex model providers have a configurable OpenAI-compatible `base_url`.
- `env_key` names the environment variable containing a provider API key.
- `wire_api` selects the provider wire protocol.
- `requires_openai_auth` controls whether the normal OpenAI authentication path is required.
- Codex supports runtime configuration overrides through `-c key=value`.

RWMCP decisions:
- The Cockpit API key is injected only into the child Codex process environment.
- The secret value is never passed in argv, logs, MCP status, task evidence or repository state.
- The worker supplies a bounded custom provider through `-c` while retaining `--ignore-user-config`; RWMCP therefore does not trust or mutate the user's global Codex configuration for worker dispatch.
- The provider base URL is always generated as loopback `http://127.0.0.1:<validated-port>/v1`.

## Cockpit Tools Codex account/API Service

Sources:
- https://github.com/jlcodes99/cockpit-tools
- https://github.com/jlcodes99/cockpit-tools/blob/main/README.en.md
- https://github.com/jlcodes99/cockpit-tools/releases
- https://github.com/jlcodes99/cockpit-tools/blob/main/src/services/codexService.ts

Relevant evidence:
- Cockpit manages Codex accounts and quota information.
- Its Codex API Service is a local OpenAI-compatible gateway backed by the bundled CLIProxyAPI sidecar.
- Current releases expose account-pool status including available / abnormal / cooling states.
- Routing supports account selection, quota/cooling handling and session affinity.
- Direct account switching in the desktop app is a Tauri `invoke('switch_codex_account', ...)` implementation detail rather than a stable external RWMCP control API.

RWMCP decisions:
- RWMCP never calls private Tauri IPC and never drives account switching by rewriting `~/.codex/auth.json`.
- The broker reads only the bounded summary index `codex_accounts.json` and safe fields from `codex_local_access.json`.
- Encrypted per-account Cockpit files are never decrypted or parsed beyond being treated as out-of-scope credential storage.
- Cockpit performs account selection/rotation inside its local API Service. RWMCP owns execution policy, Work Sessions, task lifecycle and fallback.
- RWMCP requires the Cockpit pool to be explicitly enabled, loopback-only, sidecar-backed, auto-routed, session-affine, cooling-enabled, populated with explicit account IDs and live-health reachable before it can become the Codex worker backend.
- If the pool reports rate/usage limits, the existing RWMCP Codex limit path can latch execution to `rwmcp-only` according to owner policy.

## Local evidence used for v0.25

The Windows workstation was inspected without exposing secrets:
- Cockpit Tools local version observed during development: 1.3.48.
- Cockpit data root contains a safe Codex account summary index plus encrypted credential envelopes.
- Three account summaries were present: two ChatGPT Plus profiles and one API-key profile.
- Codex API Service config existed but was disabled; its configured pool was empty.
- The local API Service therefore was deliberately not activated or used for production acceptance.

This state validates the fail-closed requirement: selecting Cockpit pool mode in RWMCP must not silently fall back to auth-file mutation or claim automatic rotation is active.

## Licensing boundary

Cockpit Tools states that its default license is CC BY-NC-SA 4.0 and that commercial use requires separate authorization from its author. RWMCP v0.25 does not copy Cockpit source code. It implements a clean interoperability adapter around owner-local runtime/config behavior. Deployments that use Cockpit in a commercial/company environment remain responsible for satisfying Cockpit's license terms independently of RWMCP.

## v0.25 invariant

Codex account failover must never create a second credential authority inside RWMCP.

RWMCP may:
- inspect bounded safe metadata;
- validate owner-selected pool readiness;
- route a Codex worker through a healthy loopback provider;
- react to bounded provider failure/limit signals;
- fall back according to owner execution policy.

RWMCP must not:
- decrypt or export Cockpit account credentials;
- persist Cockpit API keys in RWMCP settings;
- write or swap Codex `auth.json`;
- invoke private Cockpit Tauri account-switch commands;
- add accounts to a Cockpit pool without a documented owner-facing integration surface;
- claim account rotation is active when the Cockpit pool is disabled or unhealthy.
