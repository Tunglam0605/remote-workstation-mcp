# Google Antigravity worker-provider reference review

This record documents the authoritative sources and runtime evidence used for the RWMCP v0.27 `antigravity-local` worker provider.

## Source priority

1. Google Antigravity official documentation.
2. Google's `google-antigravity/antigravity-cli` repository and changelog.
3. The official `https://antigravity.google/cli/install.ps1` installer and its manifest/checksum flow.
4. Local real-machine acceptance with the installed signed `agy.exe`.
5. Third-party repositories only as design inspiration; never as authority for authentication or quota semantics.

## Official CLI and authentication

Sources:
- https://github.com/google-antigravity/antigravity-cli
- https://antigravity.google/docs/cli-install
- https://antigravity.google/docs/cli/headless/
- https://antigravity.google/docs/cli-permissions
- https://antigravity.google/docs/cli/commands/usage

Relevant evidence:
- `agy` is the official Google Antigravity CLI.
- The CLI uses the system keyring / Google Sign-In for account authentication.
- Headless mode is documented for CI, scripts, eval harnesses and programmatic drivers.
- JSON output exposes conversation id, terminal status, response and token usage.
- stream-json exposes typed `init`, `step_update` and terminal `result` events.
- stream-json input accepts typed `user` events over stdin and finishes cleanly after stdin closes.
- `--sandbox` is the documented bounded execution flag for headless runs.
- `--dangerously-skip-permissions` globally approves tools and is intentionally not used by RWMCP.
- `/usage` / `/quota` can return machine-readable quota groups without creating an agent turn.
- Current releases emit structured result/error fields and canonical `AGY_ERROR:` diagnostics for model/API failures.

RWMCP decisions:
- Never read, export, decrypt, copy or rewrite Google OAuth/keyring credentials.
- Keep authentication authority entirely inside the official `agy` process.
- Send worker prompts through stdin stream-json instead of process argv.
- Consume documented NDJSON events for evidence.
- Pass `--sandbox` on every worker dispatch.
- Never pass `--dangerously-skip-permissions`.
- Leave Antigravity tool/shell permissions under Antigravity's own permission rules.
- Require an isolated RWMCP Work Session Git worktree before dispatch.
- Record before/after Git status and diff-stat evidence.
- Keep provider registration owner-controlled in Control Center.
- Expose only safe CLI/model/quota metadata through `antigravity_status`.

## Performance split

CLI startup plus `/model` and `/usage` refresh can take several seconds. RWMCP therefore separates:
- fast provider availability: executable plus `agy --version`;
- explicit readiness/quota inspection: `/model` and `/usage` through `antigravity_status` or the owner-local Control Center.

Local measurements during development:
- fast version readiness probe: about 144 ms;
- full model + quota probe: about 17 s.

This keeps `worker_provider_list` below its bounded probe timeout while preserving an authoritative on-demand quota view.

## Official installer evidence

The Windows installer at `https://antigravity.google/cli/install.ps1` selects a platform manifest, downloads the platform binary from Google's updater service, verifies SHA-512, and installs under `%LOCALAPPDATA%\\agy\\bin\\agy.exe`.

The RWMCP shell intentionally sanitizes environment variables. The official installer relied on `PROCESSOR_ARCHITECTURE`, which was absent in the sanitized shell even though Windows and the PowerShell process were both confirmed 64-bit/x64. Installation was retried with `PROCESSOR_ARCHITECTURE=AMD64` supplied only to the official installer process; Google's own manifest and SHA-512 verification remained intact.

Local acceptance:
- `agy --version` => `1.2.7`;
- installed binary Authenticode status => valid;
- `/model` JSON => authenticated model metadata with zero turn/token usage;
- `/usage` JSON => authoritative quota groups with zero turn/token usage;
- bounded smoke run with `--sandbox` => `SUCCESS`, response `AGY_OK`.

## Known upstream behavior considered

Sources:
- https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md
- https://github.com/google-antigravity/antigravity-cli/issues

RWMCP does not depend on historical `models --output-format json` behavior because older releases had version-specific command bugs. It uses the stable CLI-handled `/model` and `/usage` print-mode JSON interfaces for readiness and quota inspection.

Non-zero exit, non-SUCCESS result, authentication errors, quota/resource-exhausted conditions, and `AGY_ERROR:` diagnostics are treated as bounded failure evidence rather than silently retrying with broader permissions.

## Architectural invariant

Antigravity is a worker, not a strategic controller.

```text
ChatGPT Web
    -> RWMCP Work Session / task binding / policy / audit
        -> antigravity-local
            -> official agy CLI
                -> Google Antigravity
```

ChatGPT Web remains responsible for architecture, task selection, decomposition, review, merge, release and production decisions.