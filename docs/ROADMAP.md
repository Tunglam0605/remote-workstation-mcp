# Roadmap

## v0.1 — Local foundation ✅

- MCP server using the official TypeScript SDK v2
- stdio + loopback Streamable HTTP
- workspace filesystem tools
- read-only Git inspection
- managed allowlisted process execution
- audit log and security regression tests

## v0.2 — Vendor-neutral / multi-client foundation

- AI-vendor-neutral core terminology
- capability discovery through `capabilities_list`
- client audit tags for dedicated profiles (observability only)
- optimistic file concurrency with SHA-256 preconditions
- multi-agent architecture documentation and regression tests

## v0.3 — Workstation UX + interoperability validation

- executable/tool discovery
- richer file/text search
- incremental process output cursors
- build/test task profiles
- compatibility test matrix for ChatGPT, Codex, Claude Code and other MCP clients
- release/update infrastructure

## v0.4 — SSH and remote machines

- named owner-approved hosts
- ssh-agent based authentication
- persistent remote process sessions
- per-host policy

## v0.5 — Trusted client identity and permission elevation

- authenticated client/principal identity
- per-client roles and capabilities
- read-only / workspace / elevated / full-control modes
- time-limited capability leases
- local approval broker
- privileged helper separated from the MCP process

## v0.6 — Concurrent agent workloads

- session/task ownership
- Git worktree isolation
- conflict detection and safe merge/review handoff

## v0.7+ — Engineering adapters

- Git write operations
- Docker
- serial/USB
- OpenOCD/GDB/ST-Link
- STM32/ESP32 workflows
- ROS 2 tooling
- pluggable vendor/debug tools

## v0.8+ — Agent orchestration

- task broker
- agent registry
- delegation contracts
- result aggregation
- agent-to-agent workflows without weakening the workstation policy boundary
