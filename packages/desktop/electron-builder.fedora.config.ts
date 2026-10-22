import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"
import config from "./electron-builder.config"

const appId = "digital.clockwork.codework"
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const metainfo = `${path.join(packageDir, "resources", "linux", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

export default {
  ...config,
  appId,
  productName: "Codework",
  artifactName: "codework-${os}-${arch}.${ext}",
  extraMetadata: { ...config.extraMetadata, desktopName: `${appId}.desktop` },
  linux: {
    ...config.linux,
    executableName: appId,
    desktop: {
      ...config.linux?.desktop,
      entry: { ...config.linux?.desktop?.entry, StartupWMClass: appId },
    },
    target: ["rpm", "deb"],
  },
  deb: { ...config.deb, packageName: "codework", fpm: [metainfo] },
  rpm: { ...config.rpm, packageName: "codework", fpm: [metainfo] },
  publish: null,
} satisfies Configuration
