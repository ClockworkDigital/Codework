# Codework

Codework is Clockwork Digital's desktop AI coding workspace, built on [OpenCode](https://github.com/anomalyco/opencode).
It combines local projects, agent tools, an embedded browser, review panels and scheduled tasks.

Connect a supported model provider through the app's provider settings. No organization-specific model relay
or employee SSO service is bundled.

## Development

```bash
bun install
bun run dev:desktop
```

The default branch is `dev`. Read [AGENTS.md](AGENTS.md) before making changes.
Run tests and type checks from their package directories.

| Area                            | Location              |
| ------------------------------- | --------------------- |
| Electron app and native browser | `packages/desktop`    |
| Shared UI                       | `packages/app`        |
| Agent browser plugin            | `packages/cm-browser` |

## Packaging

Codework branding is enabled by default. From `packages/desktop`:

```bash
OPENCODE_CHANNEL=prod CODEWORK_UNSIGNED=0 bun run build
OPENCODE_CHANNEL=prod CODEWORK_UNSIGNED=0 bun run package:mac
```

Signing and notarization credentials must be configured locally. `CODEWORK_UNSIGNED=1` produces an unsigned
build for development. Releases and updates belong to [ClockworkDigital/Codework](https://github.com/ClockworkDigital/Codework).
See [desktop installation](packages/desktop/SYSTEM_CLI.md) for details.

Clockwork artwork and Anybody fonts follow the supplied 2026 brand guidelines. The font license is included
beside the bundled font. Upstream OpenCode code remains [MIT licensed](LICENSE).
