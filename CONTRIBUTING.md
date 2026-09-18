# Contributing

Contributions are welcome, especially security reviews, tests and narrowly scoped adapters.

1. Fork the repository and create a feature branch.
2. Keep MCP protocol code, policy code and OS/tool adapters separated.
3. Never add a generic privilege bypass for convenience.
4. Add regression tests for path, process or permission changes.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before opening a pull request.

## Product-direction check

Before proposing a substantial feature, read [`docs/PROJECT_CHARTER.md`](docs/PROJECT_CHARTER.md) and classify the change as **platform capability**, **engineering-framework capability**, or **domain extension**. The pull request should be able to explain which North Star outcome it improves, how it fails closed, and why it does not unnecessarily couple the platform to one hardware/software domain.

If a proposed change conflicts with the charter, update the charter deliberately in the same review rather than allowing release notes or implementation convenience to redefine the project implicitly.

For security vulnerabilities, use GitHub Security Advisories instead of public issues.
