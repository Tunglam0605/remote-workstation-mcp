# LSP semantic code intelligence

Remote Workstation MCP can use owner-configured Language Server Protocol (LSP) processes as a **direct ChatGPT control capability**. Codex, Claude or another coding agent is not required on this path.

```text
ChatGPT / MCP client
        |
        v
Remote Workstation MCP
        |
        +-- policy + authenticated principal
        |
        +-- LSP adapter
               |
               +-- clangd / pyright / other owner-approved server
```

## Security boundary

Language servers are not discovered and launched arbitrarily by the model. The owner defines named profiles in `policy.yaml`, and the profile executable must also appear in `process.allowExecutables`.

The adapter:

- launches with `shell=false`;
- inherits only the existing filtered process environment;
- uses only owner-authorized workspace roots;
- reads documents through the workspace path guard;
- refuses files larger than `filesystem.maxReadBytes`;
- bounds each JSON-RPC message with `lsp.maxMessageBytes`;
- bounds requests with `lsp.requestTimeoutMs`;
- creates a separate language-server session per authenticated principal/workspace/profile;
- redacts definition/reference file locations outside the authorized workspace;
- classifies all current semantic tools as `workstation.read` MCP capabilities, while local policy still controls whether the configured server executable may run.

A language server is trusted local tooling selected by the owner, but its output is still treated as untrusted input by the AI client.

## Configuration

Example for C/C++ with clangd:

```yaml
process:
  allowExecutables:
    - clangd
    # ...other approved programs

lsp:
  requestTimeoutMs: 10000
  maxMessageBytes: 2097152
  diagnosticsSettleMs: 250
  servers:
    clangd:
      program: clangd
      args: [--background-index]
      languages:
        .c: c
        .h: c
        .cc: cpp
        .cpp: cpp
        .cxx: cpp
        .hpp: cpp
```

For STM32/CMake projects, clangd normally needs a valid `compile_commands.json` or equivalent project configuration to resolve include paths, defines and cross-file symbols accurately.

## MCP tools

- `lsp_servers` — list configured language-server profiles without exposing secrets.
- `lsp_definition` — resolve a source position to workspace-relative definition locations.
- `lsp_references` — resolve semantic references with optional declaration inclusion.
- `lsp_hover` — obtain type/signature/documentation hover data.
- `lsp_document_symbols` — inspect semantic symbols in one source file.
- `lsp_diagnostics` — return the latest bounded `publishDiagnostics` data after opening/synchronizing a document.

LSP positions are zero-based `line` and `character` values, matching the protocol.

## Why LSP comes before debugger automation

Text search remains useful, but semantic navigation reduces tool calls and context usage for questions such as "where is this function defined?", "who calls/references this symbol?", and "what type does this expression have?". The planned DAP/GDB/ST-Link layer builds on this code-understanding foundation rather than replacing it.
