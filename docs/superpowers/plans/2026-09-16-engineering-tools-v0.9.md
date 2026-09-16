# Engineering Tools v0.9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the first stable typed engineering-tool layer for RWMCP across Windows and Linux.

**Architecture:** Typed MCP contracts delegate to isolated engineering adapters and constrained providers. Policy, resource locking, path containment and authenticated scope classification remain in the RWMCP control plane.

**Tech Stack:** TypeScript, Node.js, MCP, node-pty, serialport, OpenOCD, GDB/MI, ESP-IDF, ros2cli, Docker CLI.

**Spec:** `docs/superpowers/specs/2026-09-16-engineering-tools-design.md`

## Global Constraints
- Keep raw shell separately elevated.
- Use `shell=false` for provider execution.
- Do not expose irreversible provisioning operations in v0.9.0.
- Keep Windows and Linux release gates green.
- Pin native runtime dependencies.

---

### Task 1: Engineering foundation
- [x] Add resource leasing, hardware discovery, serial sessions and PTY/ConPTY.
- [x] Add caller ownership, bounded buffers and lifecycle tests.

### Task 2: Firmware providers
- [x] Add project/artifact inspection and generic build contract.
- [x] Add OpenOCD/ST-Link flash/verify/reset and ESP-IDF provider activation.
- [x] Add probe-selection, project-containment and target-config hardening tests.

### Task 3: Debugging
- [x] Add token-correlated GDB/MI client and loopback-only OpenOCD session.
- [x] Add halt/resume/step/stack/register/variable/breakpoint/memory-read/fault tools.
- [x] Keep arbitrary command, memory-write and GDB-flash surfaces unavailable.

### Task 4: ROS 2 and containers
- [x] Add bounded ROS 2 graph/read/mutation contracts.
- [x] Add typed Docker list/inspect/log/lifecycle/build/exec contracts.
- [x] Block container shell-host bypass.

### Task 5: Security and distribution
- [x] Register authenticated tool scopes and engineering policy gates.
- [x] Pin node-pty and serialport.
- [x] Add native packed-artifact smoke path matching production install behavior.
- [ ] Verify Windows full release gate.
- [ ] Verify Linux packed artifact and full test gate.
- [ ] Publish v0.9.0 and update all managed nodes.
