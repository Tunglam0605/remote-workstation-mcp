# RWMCP Windows v0.71.0 — release candidate acceptance

Date: 2026-10-14 | Candidate source branch: `release/windows-v0.71.0-candidate-20261014`

## Release boundary

- Distribution: **Windows** RWMCP only. Do **not** update Ubuntu Personal, Ubuntu Vision or SSD.
- Current installed runtime: `v0.70.0-dev.10` — keep running throughout candidate qualification.
- Candidate package: `0.71.0`; it is **not yet a GitHub Release or an installed runtime** until official gates pass.
- Existing RWMCP Work Session, owner authority, scoped tool permissions and update/rollback mechanisms must remain intact.
- Changes aggregated from development PRs **#259 → #267**. ChatGPT Action Schema advances **73 → 74** because four new top-level MCP tool definitions require client catalog refresh. The aggregate candidate PR is the delivery/review boundary, and stacked draft PRs are background change histories.
- Releasing RWMCP does not imply fully autonomous manufacture-quality PCB design; KiCad automation remains **experimental / review-only** with DRC and design-authority gates.

## Candidate functionality (implemented)

1. KiCad 10 native net parsing and measured constraint-based PCB placement proposals.
2. Isolated DRC-gated routing and bounded failure isolation; rolled-back rejected copper.
3. Native curved/concave Edge.Cuts-aware mechanical placement and A* copper/via boundary.
4. SHA-locked project-local mechanical placement previews and safe single-endpoint signal-copper repair.
5. KiCad native Specctra DSN export into owner-authorized copied projects.
6. Source-bound SES import to a copied PCB, preserving footprint/pad/net/zone/outline identity and existing protected power tracks; official before/after DRC gate. **Valid Freerouting SES positive path remains unvalidated on this host**.
7. Native KiCad copper-zone refill on a copy and independent official DRC/parity gate; tested on original+unfilled archived Mega Shield zones.
8. Improved technical docs and audit evidence for specialized KiCad open-source agent repositories and license boundaries.

## Release decision table

| Gate | Requirement | Initial status |
|---|---|---|
| Source and version | `package.json`, package-lock, both plugin manifests, `SERVER_VERSION` = 0.71.0 | Candidate staged |
| Permissions and safety | Explicit Work Session + workstation.write, no uncontrolled source edits or manufacturing output | Previously tested locally; revalidate |
| Typecheck, security and architecture | `npm run verify`, 0 fails | Pending candidate run |
| Isolated packaging | `npm pack` then `smoke-package-windows.ps1` using actual production dependencies | Pending |
| CI Windows | Full Windows Actions CI green **on exact candidate commit** | Pending |
| PowerShell/runtime recovery | Windows updater/restart/rollback regression checks | Pending candidate CI |
| Live workstation trust | Hosted v0.70.0-dev.10 stays healthy and original V19 source SHA unchanged | Recheck before/after |
| Target release | No prior `v0.71.0` tag/release, strict tag hash and SHA-256 of all assets | Not attempted |
| Install and rollback | Clean user-slot installation and guarded previous-slot rollback exercised on disposable profile (no production overwrite) | Not yet performed |
| Owner acceptance | Explicit approval to publish and deploy tagged `v0.71.0` | Not yet requested |

**Decision rule:** If any mandatory build/CI/packed-runtime/rollback check fails, no tag, no GitHub Release and no runtime deployment.

## KiCad engineering limitations and promises

- Real V19 source PCB remains **85 unconnected items**. A *separate* bounded 4-round automatic routing candidate reached **75**, with zero new active geometry violations. Neither is ready for Gerber/PCB manufacturing.
- Real saved/archived zone test: unfilled GND `B.Cu` region was recreated, official DRC unconnected **37→15**, zero geometry/parity regressions. This is an acceptance fixture, not V19.
- Java/Freerouting not provisioned on PATH at last assessment. Native SES importer has negative-path KiCad acceptance and isolated mock positive tests, **not a validated actual DSN → solver → SES → KiCad path**.
- Copper power/thermal/EMI, differential/high-speed impedance, full via/branch reroute, STL/STEP 3D interference, Mega shield mechanical fit and end-to-end full-board routing require human engineering review and future implementation.
- Repository code remains Apache-2.0 and does not copy GPL/AGPL upstream autorouter source.

## Human-safe publication plan (do not auto-run)

1. Review aggregate draft PR and resolve stack/CI changes.
2. Validate candidate commit in Windows GitHub Actions and on the real machine: package smoke, Work Session authority, KiCad10 native DRC, update state and rollback.
3. Verify `BUILD_CHANNEL='stable'` on the final candidate and use the same commit for GitHub Windows CI, packaging and tagged release. Any change after the verified commit must restart the gates.
4. Merge reviewed candidate into the approved release branch, create exact annotated tag `v0.71.0` and verify commit identity; use official release workflow to create draft release and assets/SBOM/SHA256SUMS.
5. Verify the immutable release assets, publish only after explicit owner decision, then separately install on the owner's machine using its SHA-verified version-pinned updater.
6. Verify OpenAI Secure MCP Tunnel, direct control, Work Session and rollback. Abort/rollback immediately if active runtime health degrades.
