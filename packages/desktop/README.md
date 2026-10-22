# Codework desktop

Electron shell for Clockwork Digital's Codework. The main process owns native windows, the embedded browser,
file pickers, password vault, installer and updater. Renderer access goes through the typed preload API.

## Development

Run `bun run dev:desktop` from the repository root. Do not restart a running app or sidecar while debugging.
Configure model providers through the normal OpenCode provider settings. The proprietary browser relay and
its SSO controls are removed.

From this directory, run `bun typecheck` and the relevant `bun test` suites. Browser tools are bundled from
`../cm-browser`; optional AE tooling is staged from the existing vendor artifact.

## Branding and installation

The product is Codework, app ID `digital.clockwork.codework`, maintained in `ClockworkDigital/Codework`.
Branding is enabled by default. The supplied Clockwork icon is used for native app icons; the official company
wordmark stays intact. See [SYSTEM_CLI.md](SYSTEM_CLI.md) for signed macOS packaging and user installation.
