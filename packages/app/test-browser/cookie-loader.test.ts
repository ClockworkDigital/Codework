import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { paths } from "@opencode-ai/ui/phosphor"

test("cookie loaders render independently without providers and preserve the original artwork", async () => {
  const directory = await mkdtemp(resolve("test-browser/.cookie-loader-"))
  const host = document.createElement("div")
  document.body.append(host)
  try {
    await Bun.write(
      join(directory, "fixture.tsx"),
      `
      import { render } from "solid-js/web"
      import { CookieLoader } from "@opencode-ai/ui/cookie-loader"
      export function mount(host) {
        return render(() => <>
          <CookieLoader />
          <CookieLoader width={42} height={28} class="compact" classList={{ active: true }} style={{ color: "red" }} />
        </>, host)
      }
      `,
    )
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [solid()],
      build: {
        outDir: join(directory, "dist"),
        lib: { entry: join(directory, "fixture.tsx"), formats: ["es"], fileName: "fixture" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "dist/fixture.js")).href)
    const dispose = fixture.mount(host)
    try {
      const loaders = Array.from(host.querySelectorAll('[data-component="cookie-loader"]'))
      expect(loaders).toHaveLength(2)
      const masks = loaders.map((loader) => loader.querySelector("mask")!.id)
      expect(new Set(masks).size).toBe(2)
      loaders.forEach((loader, index) => {
        expect(masks[index]).toBeTruthy()
        expect(loader.getAttribute("aria-hidden")).toBe("true")
        expect(loader.getAttribute("focusable")).toBe("false")
        expect(loader.getAttribute("viewBox")).toBe("-100 -24 456 304")
        expect(loader.querySelector('[data-slot="cookie"] path')?.getAttribute("d")).toBe(paths.cookie)
        expect(loader.querySelector("[mask]")?.getAttribute("mask")).toBe(`url(#${masks[index]})`)
        expect(loader.querySelectorAll('[data-slot="bite"]')).toHaveLength(4)
        expect(loader.querySelectorAll('[data-slot="crumbs"]')).toHaveLength(4)
      })
      expect(loaders[0].getAttribute("width")).toBe("120")
      expect(loaders[0].getAttribute("height")).toBe("80")
      expect(loaders[1].getAttribute("width")).toBe("42")
      expect(loaders[1].getAttribute("height")).toBe("28")
      expect(loaders[1].classList.contains("compact")).toBe(true)
      expect(loaders[1].classList.contains("active")).toBe(true)
      expect(loaders[1].getAttribute("style")).toContain("color: red")
    } finally {
      dispose()
    }
    expect(host.childElementCount).toBe(0)
  } finally {
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
})
