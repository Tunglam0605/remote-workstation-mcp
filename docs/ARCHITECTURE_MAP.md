# RWMCP Architecture Map

> Status: architecture-consolidation target. `PROJECT_CHARTER.md` remains the product authority; `ARCHITECTURE.md` remains the detailed system design.

## Stable dependency direction

```text
AI controllers
      |
      v
MCP protocol / composition
      |
      +--------------------+
      |                    |
      v                    v
Platform services     Extension registry
      |                    |
      v                    v
Engineering framework <- Domain/productivity/app extensions
```

Allowed dependency direction:

```text
extensions -> engineering framework -> platform
mcp/composition -> platform + engineering + extensions
control center -> local APIs
```

Forbidden direction:

```text
platform -> domain extension
engineering framework -> app/productivity extension
security/adapters -> extension composition
MCP tool handler -> extension composition
```

## Layer ownership

### Platform
Generic capabilities that remain useful without any engineering domain: identity, authentication, scopes, policy, approval, audit, workspace/host filesystem, process, PTY, Git, LSP, browser primitives, Work Session ownership, concurrency, node lifecycle, update/recovery, direct-node transport and the bounded data plane.

### Engineering framework
Reusable engineering abstractions: project profiles, typed workflow execution, provider contracts, artifact integrity, hardware/resource leases and diagnostics.

### Extensions
Capabilities that do not define the workstation platform itself:
- domain: STM32, ESP32, ROS 2, CAN, Modbus, KiCad, PLC;
- productivity: Office;
- app integrations: NotebookLM and future cloud/UI integrations.

Extensions register through `src/extensions/registry.ts`. During migration, legacy MCP handler modules may remain under `src/tools`, but extension composition must live only in `src/extensions`.

### Orchestration
Deterministic coordination only: Work Objective, persistent task graph, scheduler and typed worker routing. It never becomes an autonomous reasoning or engineering-strategy layer.

### MCP protocol layer
MCP handlers validate public contracts and delegate to services. They are not the preferred home for domain business logic.

## Migration rules
1. Public MCP names and schemas remain stable unless a deliberate Action Schema change is approved.
2. Refactors move implementation behind existing contracts before renaming or deleting public surfaces.
3. Every migrated extension declares a stable id, extension API version, kind and platform support.
4. New domain-specific work must enter through an extension boundary.
5. New generic primitives must prove reuse outside the motivating extension before entering Platform.
6. Architecture checks run in CI and block reverse dependencies.
7. Runtime, security and update behavior take precedence over directory aesthetics; migrations remain incremental and regression-tested.

## Target source map

```text
src/
  platform/
  sessions/
  engineering/
  extensions/
    office/
    notebooklm/
    stm32/
    esp32/
    ros2/
    can/
    modbus/
    kicad/
  orchestration/
  mcp/
  bootstrap/
control-center/
scripts/
  install/
  runtime/
  update/
  ci/
  maintenance/
tests/
  unit/
  contract/
  integration/
  platform/
```

The target map is intentionally incremental. Existing paths are migrated only when tests prove unchanged behavior.
