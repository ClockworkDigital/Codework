# Fedora 44

Build the branded RPM on Linux:

```bash
CODEWORK_BRAND=1 CODEWORK_UNSIGNED=1 OPENCODE_CHANNEL=prod bun run build
CODEWORK_BRAND=1 CODEWORK_UNSIGNED=1 OPENCODE_CHANNEL=prod bun x electron-builder --linux rpm --publish never --config electron-builder.fedora.config.ts
```

Install the resulting package:

```bash
sudo dnf install ./dist/codework-linux-x86_64.rpm
```

The `codework-desktop` GitHub Actions workflow includes the RPM in Codework releases and verifies installation in a Fedora 44 container.
