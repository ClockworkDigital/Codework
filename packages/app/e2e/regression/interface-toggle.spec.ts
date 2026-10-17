import { expect, test } from "@playwright/test"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"

const branded = process.env.VITE_CM_BRAND === "1"

test.beforeEach(async ({ page }) => {
  await page.route("**/pty/shells", (route) =>
    route.fulfill({ json: [], headers: { "access-control-allow-origin": "*" } }),
  )
})

for (const initial of [false, true]) {
  test(`New Interface preserves session and draft when starting ${initial ? "enabled" : "disabled"}`, async ({
    page,
  }) => {
    test.skip(!branded, "CookieMonster presentation switch")
    await mockStressTimeline(page)
    await installStressSessionTabs(page)
    await page.addInitScript((initial) => {
      if (localStorage.getItem("settings.v3")) return
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: initial } }))
    }, initial)
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    const shell = page.locator('[data-component="current-ui"]')
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await expect(input).toBeEditable()
    await input.fill("Keep this draft while switching interfaces")
    const editor = await input.elementHandle()
    const url = page.url()
    await page.getByRole("switch", { name: "Dark", exact: true }).focus()
    await page.keyboard.press(
      await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta+," : "Control+,")),
    )
    const toggle = page.locator('[data-action="settings-new-layout-designs"]').getByRole("switch")
    await expect(toggle).toHaveAttribute("aria-checked", String(initial))
    await expect(page.locator('[data-action="settings-quiet-companion"]')).toHaveCount(0)
    for (const enabled of [!initial, initial]) {
      await toggle.press("Space")
      await expect(toggle).toHaveAttribute("aria-checked", String(enabled))
      if (enabled) await expect(shell).toHaveClass(/cm3-live/)
      if (!enabled) await expect(shell).not.toHaveClass(/cm3-live/)
      await expect(input).toHaveText("Keep this draft while switching interfaces")
      expect(await input.evaluate((element, original) => element === original, editor)).toBe(true)
      await expect(page).toHaveURL(url)
      await expect
        .poll(() =>
          page.evaluate(() => JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general?.newLayoutDesigns),
        )
        .toBe(enabled)
    }
    await page.keyboard.press("Escape")
    await page.reload()
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await expect(input).toHaveText("Keep this draft while switching interfaces")
    await page.getByRole("switch", { name: "Dark", exact: true }).focus()
    await page.keyboard.press(
      await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta+," : "Control+,")),
    )
    await expect(toggle).toHaveAttribute("aria-checked", String(initial))
  })

  test(`New Interface migrates the previous Quiet Companion choice ${initial}`, async ({ page }) => {
    test.skip(!branded, "CookieMonster preference migration")
    await mockStressTimeline(page)
    await installStressSessionTabs(page)
    await page.addInitScript((initial) => {
      if (localStorage.getItem("settings.v3")) return
      localStorage.setItem(
        "settings.v3",
        JSON.stringify({ general: { newLayoutDesigns: !initial, quietCompanion: initial } }),
      )
    }, initial)
    await page.goto(stressSessionHref(fixture.sourceID))
    await expectSessionTitle(page, fixture.expected.sourceTitle)
    await expect
      .poll(() =>
        page.evaluate(() => {
          const general = JSON.parse(localStorage.getItem("settings.v3") ?? "{}").general
          return { enabled: general?.newLayoutDesigns, legacy: general?.quietCompanion }
        }),
      )
      .toEqual({ enabled: initial, legacy: undefined })
    await page.getByRole("switch", { name: "Dark", exact: true }).focus()
    await page.keyboard.press(
      await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta+," : "Control+,")),
    )
    await expect(page.locator('[data-action="settings-new-layout-designs"]').getByRole("switch")).toHaveAttribute(
      "aria-checked",
      String(initial),
    )
  })
}

test("unbranded OpenCode retains its existing interface preferences", async ({ page }) => {
  test.skip(branded, "Upstream behavior")
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: false, quietCompanion: true } }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator('[data-component="current-ui"]')).toHaveClass(/cm3-live/)
  await page.getByRole("switch", { name: "Dark", exact: true }).focus()
  await page.keyboard.press(
    await page.evaluate(() => (/Mac|iPod|iPhone|iPad/.test(navigator.platform) ? "Meta+," : "Control+,")),
  )
  await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible()
  await expect(page.locator('[data-action="settings-new-layout-designs"]')).toHaveCount(0)
  await expect(page.locator('[data-action="settings-quiet-companion"]').getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "true",
  )
})
