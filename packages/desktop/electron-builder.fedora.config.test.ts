import { expect, test } from "bun:test"

import config from "./electron-builder.fedora.config"

test("builds an installable Codework RPM", async () => {
  expect(config.appId).toBe("digital.clockwork.codework")
  expect(config.productName).toBe("Codework")
  expect(config.artifactName).toBe("codework-${os}-${arch}.${ext}")
  expect(config.extraMetadata?.desktopName).toBe("digital.clockwork.codework.desktop")
  expect(config.linux?.executableName).toBe("digital.clockwork.codework")
  expect(config.linux?.desktop?.entry?.StartupWMClass).toBe("digital.clockwork.codework")
  expect(config.linux?.target).toEqual(["rpm", "deb"])
  expect(config.deb?.packageName).toBe("codework")
  expect(config.deb?.fpm).toEqual(config.rpm?.fpm)
  expect(config.publish).toBeNull()
  expect(config.rpm?.packageName).toBe("codework")
  expect(config.rpm?.fpm).toContainEqual(
    expect.stringContaining("/usr/share/metainfo/digital.clockwork.codework.metainfo.xml"),
  )
  expect(await Bun.file("resources/linux/digital.clockwork.codework.metainfo.xml").exists()).toBe(true)
})
