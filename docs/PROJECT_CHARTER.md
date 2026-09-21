# Remote Workstation MCP Project Charter

> **Status: authoritative product-direction document**
>
> This charter defines **why Remote Workstation MCP exists, what belongs in the platform, what belongs in extensions, and how new work is evaluated**. If a roadmap item, release note, implementation shortcut, or domain-specific feature conflicts with this charter, **this charter wins until it is deliberately amended**.

## 1. Mission

Remote Workstation MCP (RWMCP) exists to let an **authorized AI client securely operate one or many owner-controlled workstations** through independent Direct Nodes and typed, policy-enforced tools.

RWMCP is an **AI-vendor-neutral workstation control plane**. ChatGPT Web is a first-class controller, while Codex, Claude, IDE agents and other MCP clients may use the same workstation interface without becoming required middleware.

The local owner remains the authority over access, permissions, privileged actions, workspaces, devices and security policy.

## 2. North Star

The product should converge toward this experience:

1. **Install once per workstation.**
2. **Each workstation is independently reachable** through its own Direct Node; no permanent master PC or SSH hub is required.
3. The owner can operate the workstation from **ChatGPT Web, desktop or phone** with minimal repeated setup.
4. Common work is performed through **typed, bounded tools and reusable workflows before raw shell**.
5. The runtime **starts automatically, updates safely, recovers from crashes/network loss, and remains observable**.
6. Multiple workstations can cooperate without weakening the security boundary of either node.
7. Large data should move through an explicit data plane; the AI control plane should exchange commands, plans, summaries and bounded results rather than becoming a bulk-data relay.
8. Domain-specific engineering capabilities should be reusable extensions of the platform, not redefine the product.

A successful RWMCP release should make remote workstation operation **safer, simpler, more reliable, more generic, or more observable**.

## 3. Product Boundary

### 3.1 Core platform

The core platform owns capabilities that are useful across many workstation tasks and engineering domains:

- Direct Node identity, reachability and health;
- authentication, authorization, scopes, local policy, leases, approvals and audit;
- setup, Control Center, TUI, startup, update, rollback, watchdog and recovery;
- workspace and host filesystem access;
- managed process and terminal/PTTY execution;
- Git and semantic/LSP operations;
- generic task/build diagnostics;
- generic device discovery/routing;
- secure multi-node coordination;
- generic node-to-node data/artifact transfer;
- generic resource/session ownership and conflict prevention;
- capability discovery and stable MCP contracts.

These capabilities must remain useful without STM32, ESP32, ROS 2, vision, OTA or any other single engineering domain.

### 3.2 Engineering framework

The engineering framework is a reusable layer above the core platform:

- project inspection;
- canonical project profiles;
- workflow planning/execution;
- artifact integrity;
- hardware/resource leasing;
- serial/debug session lifecycle;
- provider discovery and typed provider contracts.

The framework may host domain-specific providers, but its abstractions should remain reusable across domains.

### 3.3 Domain extensions

Domain extensions may use the core platform and engineering framework:

- STM32 / OpenOCD / ST-Link / Keil;
- ESP32 / ESP-IDF;
- ROS 2;
- computer vision;
- OTA/update systems;
- future robotics, embedded, industrial and development-tool integrations.

**Extensions may depend on core/platform abstractions. The product direction must not become dependent on one extension.**

A feature that only makes sense for one domain should normally live in that domain layer rather than becoming a new generic top-level product concept.

## 4. Architectural Invariants

The following rules are product-level invariants:

1. **Direct Node first.** Normal multi-PC control must not require one workstation to stay online as a gateway for the others.
2. **Owner authority first.** AI output is untrusted input; local policy and explicit owner approvals are authoritative.
3. **Typed operation first.** Prefer typed tools, structured plans and bounded workflows before raw shell or opaque command strings.
4. **Fail closed.** Missing identity, ambiguous target, failed integrity check, unavailable hardware or insufficient permission should block mutation rather than guess.
5. **Stable contracts.** Prefer extending generic workflow/profile parameter envelopes over unnecessary top-level MCP action growth.
6. **No privilege shortcut.** Full user-level control does not imply Administrator/root. Privileged elevation requires a distinct owner-approved boundary.
7. **No secret exposure by design.** Credentials, ephemeral tickets and private key material must not be echoed in plans, logs or normal model-visible inventory.
8. **Local isolation.** The normal MCP runtime remains loopback-bound; remote reachability is provided by approved outbound secure transports.
9. **Generic before specific.** When a domain feature exposes a reusable primitive, extract or design the reusable primitive rather than hard-coding the platform around the domain.
10. **Observability and cleanup.** Managed processes, leases, sessions, temporary listeners and artifacts must have explicit lifecycle, bounded state and cleanup behavior.
11. **No horizontal authority.** A Direct Node must not gain command authority, credentials, data-read authority or implicit trust over another Direct Node merely because both are connected to the same AI controller. Compromise of one node must not confer authority over another.
12. **Bilateral transfer authorization.** Cross-node data movement is default-deny and requires an explicit directional owner grant on both participating nodes, the authenticated owner-approved AI control-plane principal, and an exact match for node identities, workspaces, path boundaries, file type, size and transport.
13. **Data transfer is not remote control.** A transfer grant authorizes bounded bytes only. It must never authorize remote command execution, arbitrary pull of peer data, hardware mutation or reuse of the peer's credentials.
14. **Work Session identity is not authority.** A Work Session is durable application-level execution context, not a credential. Session permissions and resource access must remain a subset of the authenticated principal and local owner policy; a session cannot grant Full Control, raw shell, host filesystem access, Administrator/root or cross-node trust.
15. **Conversation history is not canonical state.** Resumable work must persist only compact, bounded, non-secret project/session facts and lifecycle state. Full transcripts, large raw logs and speculative model narrative must not become control-plane truth.
16. **Reasoning stays in the controller.** ChatGPT Web or another authorized AI client is responsible for analysis, planning, engineering judgement, task decomposition and review. RWMCP may expose deterministic coordination state, typed execution primitives and safety policy, but it must not become an autonomous strategic planner, choose engineering direction, or silently assign work on behalf of the controller.

## 5. Multi-Node Direction

The preferred topology is independent Direct Nodes:

```text
                         AI client
                    /       |       \
                   /        |        \
             Secure      Secure      Secure
             tunnel      tunnel      tunnel
                |           |           |
             Node A       Node B       Node C
              RWMCP        RWMCP        RWMCP
```

A node outage must not make unrelated nodes unreachable.

Cross-node cooperation should use explicit, generic capabilities such as identity, health, routing and a secure data plane. ChatGPT/another authorized AI client coordinates each Direct Node independently; one node does not command another.

Cross-node data exchange is **default-deny**. The source node must independently authorize release of the exact data and the destination node must independently authorize receipt under the same directional grant. A local user, local HTTP caller, compromised workstation, leaked transfer ticket, or Full Access lease on one node must not be sufficient to read data from another node.

Legacy SSH/hub routing may remain available for deliberate bootstrap or recovery, but it is **locally disabled by default** and is not the normal Direct-Node architecture.

## 6. Non-Goals

RWMCP is **not** intended to become:

- an STM32-only programmer/flasher;
- a ROS 2-only management tool;
- an ESP32-only development environment;
- a replacement for an IDE, source-control host or CI system;
- an unrestricted autonomous root/Administrator agent;
- an autonomous reasoning/planning brain that replaces the AI client or silently decides engineering strategy;
- dependent on one AI vendor;
- dependent on one permanent master workstation;
- a generic way to bypass local OS security;
- a bulk file relay through the model when a direct data plane is appropriate.

Domain tools can be excellent acceptance workloads, but they are **validation of the platform**, not the definition of the platform.

## 7. Feature Classification Gate

Before implementation, every substantial feature should be classified:

### Platform capability

Use this when the capability is broadly reusable across workstation tasks.

Examples: node health, file transfer, process lifecycle, permissions, terminal, Git, update/recovery.

### Engineering-framework capability

Use this when the capability supports multiple engineering domains through reusable abstractions.

Examples: project profile, workflow engine, artifact integrity, resource leases.

### Domain extension

Use this when the behavior is specific to one technology stack or hardware family.

Examples: OpenOCD flash, ESP-IDF monitor, ROS 2 topic inspection.

If the classification is unclear, design should stop long enough to determine the boundary instead of adding a convenient one-off primitive.

## 8. Change Decision Gate

A new feature or architectural change should answer all of these questions before merge:

1. **Which North Star outcome does this improve?**
2. **Is it platform, engineering framework, or domain extension?**
3. **Can a generic primitive be reused outside the motivating use case?**
4. **Does it create a new dependency on a master PC, LAN, VPN, AI vendor or domain-specific stack?**
5. **Does it bypass an existing typed tool, policy boundary, integrity check or lifecycle manager?**
6. **Does it increase first-run or daily-operation complexity? If so, what removes equivalent complexity elsewhere?**
7. **How does it fail closed?**
8. **How is its state observed and cleaned up?**
9. **Does it require a public action/schema change, or can it fit the stable generic contract?**
10. **What regression or real acceptance proves it without redefining the product around the test workload?**
11. **Which authoritative vendor/specification/upstream sources were reviewed, and what concrete design decision came from them?** Domain-depth work should prefer official manuals, standards/specifications, vendor-maintained repositories and upstream tool documentation over ad-hoc reimplementation. Community sources may inform investigation but are not the authority for safety, protocol or tool semantics.

A feature that cannot answer these questions should not advance simply because it is technically possible.

## 9. Priority Order

When priorities compete, prefer work in this order unless there is a documented operational incident:

1. Direct Node reliability, recovery and security;
2. setup/onboarding and daily UX;
3. multi-node identity, health, coordination and generic data plane;
4. generic filesystem/process/terminal/Git/LSP/tooling quality;
5. engineering-framework reuse and safety;
6. domain-extension depth;
7. optional agent orchestration.

This ordering prevents a successful domain experiment from consuming the roadmap of the workstation platform itself.

## 10. Documentation Authority

Project documentation has distinct roles:

```text
PROJECT_CHARTER.md      -> WHY / product direction / boundaries
ARCHITECTURE.md         -> HOW / system structure and invariants
ROADMAP.md              -> WHEN / planned and completed milestones
ENGINEERING_TOOLS.md    -> domain/framework capabilities
README.md               -> user-facing overview and entry point
```

Release notes describe what changed; **they do not redefine the mission**.

If documents disagree, resolve the disagreement explicitly rather than silently following the most recently edited file.

## 11. Charter Change Policy

This charter is intentionally more stable than the roadmap.

A change to this file should be deliberate and should explain:

- what product assumption changed;
- why the previous boundary is no longer appropriate;
- what architecture/roadmap consequences follow;
- whether existing extensions or tools need reclassification.

Routine releases, provider additions and domain-specific features should not require charter changes.
