# Windows npm process launch — design (2026-10-25)

## Intent
Make the owner-authorized `process_start(program: "npm")` work on Windows without opening a general-purpose shell. Observed on Windows v0.71.0: `tool_discover` reports npm allowed but `spawn npm ENOENT` because npm is distributed as `npm.cmd`.

## Constraints
- No change to production v0.71.0; implement in an isolated branch based on KiCad integration PR #272.
- Owner policy remains authoritative: check requested logical program `npm` before resolving a launcher; never grant new executables, modify policy or activate a raw shell.
- Other executables remain untouched. No generic `.cmd`/batch execution support.
- Arguments stay as an array, with no command-line interpolation, no `cmd.exe`, and no `shell: true`.
- Preserve process id ownership, cancellation, stdout/stderr, timeout, safe env, and `ProcessManager` public API.
- Ship nothing until tests, Windows native launch check, GitHub security audit and KiCad acceptance are green.

## Approaches
1. **Chosen — narrow npm shim resolver**: after owner policy check, only for a requested `npm`/explicitly allowed `npm.cmd` on Windows, locate the colocated `npm.cmd` and `node_modules/npm/bin/npm-cli.js` from the executable directory/PATH; spawn the trusted Node executable with that script and unchanged args. No shell surface; small code path. Trade-off: only fixes npm and conventional Node installations.
2. Generic cmd wrapper: supporting all `.cmd` would require shell quoting and create injection risks; out of scope.
3. Owner `cmd.exe` allowlisting or raw-shell workaround: masks the RWMCP bug and broadens privileges; rejected.

## Acceptance
- Unit tests RED before implementation, then GREEN for Windows npm resolution, argument preservation, fail-closed missing shim and non-Windows no-op.
- Owner `npm` allowlist succeeds; denied `npm` remains denied.
- Windows verification of `npm --version` via a *development runtime*, not the stable runtime.
- `npm run verify`, Windows CI/security audit, and KiCad isolated-copy checks must pass before merge/deployment.
