# Plugin usage terms

Remote Workstation MCP is open-source software distributed under the Apache License 2.0. The repository `LICENSE` file remains the controlling software license.

## Intended use

The software is intended to let an owner-authorized AI client operate selected files, development tools, processes, Git repositories, and SSH hosts on computers the user is authorized to control.

## Security-sensitive software

This project can execute programs and modify files. Optional elevated user-level features can access the host filesystem and raw shell when the owner explicitly enables local policy gates and grants a time-limited permission lease. Root/Administrator access is not part of the normal MCP process.

Users are responsible for:

- configuring least-privilege workspace, executable, SSH, and permission policies;
- protecting credentials and private keys;
- reviewing changes before enabling elevated capabilities;
- complying with rules and authorization requirements on local and remote systems;
- backing up important data before allowing automated modifications.

## No credential collection

The project does not require users to provide passwords or SSH private-key contents to an AI client. Do not place secrets in plugin prompts, public issues, or repository configuration.

## Third-party services

Use through ChatGPT, Codex, Claude, Cursor, GitHub, SSH servers, or other software remains subject to those services' respective terms and policies.

## Warranty

The software is provided under the warranty and liability terms of the Apache License 2.0. It is security-sensitive software and should be validated in a disposable or non-critical workspace before broader use.
