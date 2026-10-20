import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"
import { chromium } from "@playwright/test"
import { build } from "vite"
import solid from "vite-plugin-solid"

test("session cookies share their animation and phase across late mounts, updates, and reduced motion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-loading-"))
  // SVG images follow Chromium's own reduced-motion preference (the OS setting on Windows), not page emulation.
  // Pin it so the motion checks are deterministic; page emulation below still covers reduced motion.
  const browser = await chromium.launch({ args: ["--force-prefers-no-reduced-motion"] })

  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname

    if (pathname === "/") {
      response.setHeader("Content-Type", "text/html")
      response.end(
        '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script type="module" src="/fixture.js"></script>',
      )

      return
    }

    const file = Bun.file(join(directory, pathname))
    response.setHeader("Content-Type", file.type)
    response.end(Buffer.from(await file.arrayBuffer()))
  })

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()

  if (!address || typeof address === "string") throw new Error("Loader fixture server did not bind")

  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [solid()],
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: {
          entry: resolve("test-browser/cm-loading.fixture.tsx"),
          formats: ["es"],
          fileName: () => "fixture.js",
          cssFileName: "fixture",
        },
      },
    })
    const page = await browser.newPage({ viewport: { width: 600, height: 500 } })
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.waitForSelector('#project [data-loading-animation="flip-3d"]')

    const variants = () =>
      page
        .locator("#project svg")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-loading-animation")))

    const initial = await variants()
    expect(new Set(initial).size).toBe(6)
    expect(await page.locator("#stock [data-loading-animation]").count()).toBe(0)
    expect(await page.locator("#adapters [data-loading-animation]").count()).toBe(2)
    const moving = await page.locator('#project [data-loading-animation="flip-3d"]').screenshot({ animations: "allow" })
    await page.waitForTimeout(240)
    expect(
      moving.equals(
        await page.locator('#project [data-loading-animation="flip-3d"]').screenshot({ animations: "allow" }),
      ),
    ).toBe(false)
    await page.locator("#late").click()

    const synced = async () => {
      await page.evaluate(
        () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
      )
      expect(
        await page
          .locator("#recent svg")
          .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-loading-animation"))),
      ).toEqual(await variants())
      // Sample one compositor instant; tolerate one colour level of raster rounding.
      const screenshot = await page.screenshot({ animations: "allow" })

      return page.evaluate(async (bytes) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }))
        const canvas = document.createElement("canvas")
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const context = canvas.getContext("2d")!
        context.drawImage(bitmap, 0, 0)
        bitmap.close()

        const pixels = (id: string) =>
          Array.from(document.querySelectorAll(`#${id} svg`)).map((node) => {
            const bounds = node.getBoundingClientRect()

            return Array.from(context.getImageData(bounds.x, bounds.y, bounds.width, bounds.height).data)
          })

        const project = pixels("project")

        return ["recent", "tabs"].map((id) =>
          pixels(id).map((image, index) =>
            Math.max(...image.map((value, channel) => Math.abs(value - project[index][channel]))),
          ),
        )
      }, Array.from(screenshot))
    }

    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    await page.waitForTimeout(220)
    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    await page.locator("#theme").click()
    expect(await variants()).toEqual(initial)
    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    await page.locator("#session").click()
    expect(await variants()).not.toEqual(initial)
    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    await page.locator("#late").click()
    await page.waitForTimeout(220)
    await page.locator("#late").click()
    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    await page.screenshot({ path: join(tmpdir(), "cm-loading-preview.png") })
    await page.emulateMedia({ reducedMotion: "reduce" })
    expect(
      await page
        .locator('[data-slot="loading-motion"]')
        .first()
        .evaluate((node) => getComputedStyle(node).display),
    ).toBe("none")
    expect(
      await page
        .locator('[data-slot="loading-still"]')
        .first()
        .evaluate((node) => getComputedStyle(node).display),
    ).toBe("block")
    expect((await synced()).flat().every((difference) => difference <= 1)).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
