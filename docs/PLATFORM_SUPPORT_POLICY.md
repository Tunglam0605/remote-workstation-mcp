# RWMCP PLATFORM POLICY — WINDOWS ACTIVE / UBUNTU FROZEN

Effective: 2026-10-11. This policy records the owner's instruction: only Windows receives new RWMCP feature development, optimizations and new target-platform releases.

## 1. Target-platform matrix

| Platform | Status | Release/development policy |
|---|---|---|
| Windows engineering workstations | ACTIVE | New features, tooling, Control Center, KiCad/PCB, security and performance work, Windows CI and Windows releases |
| Ubuntu Personal PC | FROZEN / LEGACY | Remain on observed installed v0.66.0; no automatic upgrades or new feature builds |
| Ubuntu Vision PC | OFF BY OWNER | Do not wake, restart, connect or count offline as a failure; software version currently unverified |
| External SSD Ubuntu PC | OFF BY OWNER | Do not wake, restart, connect or count offline as a failure; software version currently unverified |
| Other Linux deployments | LEGACY | Existing historical release assets only; no new Linux-specific development or compatibility promise |

The v0.66.0 pin is a verified observation **for Ubuntu Personal PC only**. It must not be applied to Vision/SSD without explicit approval and version inspection.

The Linux code stays in Git history. It is not deleted, rolled back, rebuilt or silently modified. Code shared with Windows may still be present but new Windows releases carry **no claim of Ubuntu compatibility**.

## 2. Immutable legacy Linux baseline

The existing canonical v0.66.0 release is published at:
https://github.com/Tunglam0605/remote-workstation-mcp/releases/tag/v0.66.0

It contains the original install-linux.sh, archive and SHA256SUMS.txt; keep those assets untouched. Do not create a new Linux release from Windows HEAD.

For an owner-approved *new installation* explicitly requesting that frozen version, download the installer from this exact release and force the matching version:

    curl -fsSL -o install-linux-v0.66.0.sh https://github.com/Tunglam0605/remote-workstation-mcp/releases/download/v0.66.0/install-linux.sh
    RWMCP_VERSION=0.66.0 bash ./install-linux-v0.66.0.sh

Inspect and verify downloads as usual. Do NOT execute by default. The old installer otherwise resolves the newest stable GitHub release, which might be a future Windows-only version.

Already-installed legacy Ubuntu nodes should remain untouched. Their existing updater state is unknown; if an operational freeze requires disabling a local auto-updater, inspect that machine and obtain separate user authorization before making changes. Historical v0.66.0 is not an ongoing security-maintained branch. Notify the owner if a critical vulnerability affects it.

## 3. Release and CI policy

- PR/main CI shall validate **Windows only**: dependency audit, SBOM, TypeScript, architecture boundaries, tests, Windows PTY/ConPTY, packed runtime, PowerShell scripts, recovery and update safety.
- Canonical release and release-request workflows use Windows GitHub-hosted runners.
- Newly published Windows release assets are the versioned npm tarball, Windows installers (install-windows.ps1 and install-windows.cmd), SBOM and SHA256SUMS.txt. Do not bundle a new install-linux.sh asset.
- Older releases, including v0.66.0, are immutable. Do not edit their tags or release artifacts.
- These changes must go through a review PR and Windows CI before merging. They do not deploy any workstation automatically.
- Shared source files and older Linux scripts may remain for compatibility/history. New releases are **not tested or advertised as Linux-compatible**.

## 4. Engineering focus

ACTIVE: Windows Control Center, secure tunnel, permission boundaries, health/recovery, update rollback, engineering desktop tools, KiCad schematic/PCB, browser automation, file workflows, media pipelines and reliable Work Sessions.

FROZEN: Linux/Ubuntu systemd behavior, SocketCAN capture implementation, Linux installers, Ubuntu GUI, distro compatibility, Ubuntu device tuning, Ubuntu deployment or automatic OS updates.

Offline Vision/SSD nodes are **expected-off**, not production outages, until the owner explicitly asks to power them up. No agent should attempt wake/reboot/connection repair or background monitoring for those nodes.

## 5. Reversal procedure

Reopening Ubuntu development requires a new explicit owner instruction, platform-policy change and complete Linux regression/acceptance suite. Do not reactivate Linux CI or upgrade legacy Ubuntu devices by accident.

This policy does not weaken source security, user permissions, hardware interlocks, rollback/backup, or the public RWMCP tool contracts.
