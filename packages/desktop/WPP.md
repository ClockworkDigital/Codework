# Optional WPP on CookieMonster V2

The private WPP backend, model roster, Responses adapter, and native V2 provider plugin live in [CM-WPP-Bits](https://github.com/trmosala/CM-WPP-Bits), on `v2-split`. The earlier v1 extraction remains on that repo's `dev` branch. The host pins an immutable commit through `wpp/package.json` and its separate lockfile, outside the root workspace.

Normal workspace installs, app type checks, and desktop builds do not require private-repo access. From `packages/desktop`, enable WPP with:

```bash
bun run install:wpp
CM_BRAND=1 CM_WPP=1 bun run build
```

Use the same flags with `bun run dev` for a WPP development instance. `CM_BRAND=1` without `CM_WPP=1` builds generic CookieMonster with the cookie/wordmark logo and no WPP provider, bridge, or login controls. The browser and Figma plugins remain available. User config is preserved; only WPP builds seed a WPP model default. Both logo versions have light and dark themes.

WPP installation requires GitHub SSH read access. The installer uses a private cache keyed by the pinned commit, avoiding stale Bun Git clones when the dependency is updated. A CI job that sets `CM_WPP=1` passes the `CM_WPP_SSH_KEY` secret to the shared Setup Bun action's `wpp-ssh-key` input. This is a read-only deploy key. The action fetches GitHub host keys through HTTPS, uses strict SSH verification, installs private source after saving the public dependency cache, and removes temporary credentials. Generic jobs need no secret. No release is published by this setup.

## Verification

Run `bun test`, `bun typecheck`, and `bun run build:types` in the private WPP repo. The host owns tests requiring its V2 SDK/AI runtime:

```bash
CM_WPP=1 bun scripts/build-cm-plugins.ts
bun run test:wpp
bun test --preload ./test/preload.ts src/main/cm-config.test.ts src/main/wpp-integration/login-controls.test.ts
```

The optional host suite covers native/legacy provider requests, stable runtime headers, Responses image persistence, packaged plugins, and legacy config compatibility. Backend capture tests live with their implementations in the WPP repo. Vault/translation integration remains host-owned under `src/main/wpp-integration/`.

Verify the normal desktop with `wpp/node_modules` absent. When updating WPP, push its commit first, then update the host manifest and optional lockfile. Do not edit installed dependency source. Agents must not merge or publish releases.
