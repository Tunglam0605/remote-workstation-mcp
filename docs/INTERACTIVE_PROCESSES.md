# Interactive managed processes

Remote Workstation MCP supports bounded stdin interaction with a process that was already started through `process_start`.

This is intentionally **not advertised as a PTY/terminal emulator**. The current layer uses the child process stdin/stdout/stderr pipes created by Node.js with `shell=false`.

```text
GPT / MCP client
      |
      | process_start
      v
principal-owned managed process
      |
      +-- process_write --------> stdin pipe
      +-- process_close_stdin --> EOF
      +-- process_read_since <--- bounded stdout/stderr cursors
      +-- process_stop
```

## Why this layer exists

Build tools, REPL-like engineering utilities, debuggers and long-running helpers often need more than one request/response cycle. Re-spawning a process for every input loses process state and adds latency. Pipe-backed interaction gives the direct GPT control path persistent process state without weakening the existing executable policy.

A true Unix PTY / Windows ConPTY has different semantics: terminal modes, resize events, control sequences, interactive shell behavior and native dependencies. That is tracked separately as `terminal.pty`; the server does not pretend pipe I/O has those semantics.

## Security boundary

`process_write` and `process_close_stdin`:

- require `workstation.execute` for authenticated principals;
- can address only a process owned by the calling principal/client identity;
- inherit the same executable allowlist and workspace boundary enforced when `process_start` created the child;
- do not invoke a shell;
- do not accept a new executable or path;
- limit each UTF-8 write and queued stdin pressure with `process.maxInputBytes`;
- remain subject to the process maximum runtime and bounded output buffers.

A caller that learns another principal's process UUID still receives the same `Unknown process id` response used for a missing process.

## Policy

```yaml
process:
  allowExecutables:
    - node
    - python3
    - gdb
  maxOutputBytes: 262144
  maxRuntimeMs: 600000
  maxInputBytes: 65536
```

`maxInputBytes` defaults to 65536 bytes and is capped by the config schema at 1 MiB.

## Typical workflow

1. `process_start` launches an owner-approved executable.
2. `process_read_since` captures initial output and cursors.
3. `process_write` sends bounded input; set `appendNewline=true` for line-oriented programs.
4. `process_read_since` retrieves only new output.
5. `process_close_stdin` sends EOF when appropriate, or `process_stop` terminates the job.

For ordinary build/test commands, prefer owner-defined `task_run` profiles. For source navigation, prefer LSP tools. For interactive debugger control, the planned DAP/GDB adapters remain preferable to scripting a raw shell.
