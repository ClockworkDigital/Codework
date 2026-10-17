import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  completedAssistantInfo,
  directory,
  historyMessages,
  messageUpdated,
  partDelta,
  partUpdated,
  setupTimeline,
  shell,
  status,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"
import { fixture, pageMessages } from "../performance/timeline/session-timeline-stress.fixture"
import {
  installStressSessionTabs,
  mockStressTimeline,
  stressSessionHref,
} from "../performance/timeline/timeline-test-helpers"
import { expectSessionTitle } from "../utils/waits"
import { mockOpenCodeServer } from "../utils/mock-server"

for (const width of [390, 1280]) {
  test(`CM3 changed-files summary opens real Changes at ${width}px`, async ({ page }) => {
    const diff = {
      file: "src/qualification.ts",
      patch: "@@ -1 +1 @@\n-export const ready = false\n+export const ready = true\n",
      additions: 1,
      deletions: 1,
    }
    await setupTimeline(page, {
      viewport: { width, height: 850 },
      settings: { newLayoutDesigns: true, quietCompanion: true },
      messages: [
        userMessage(undefined, { summary: { diffs: [diff] } }),
        assistantMessage([textPart("prt_summary_reply", "The file is ready.")]),
      ],
    })
    const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
    await input.fill("Keep my follow-up")
    const summary = page
      .locator('[data-slot="session-turn-diffs-header"]')
      .getByRole("button", { name: "1 Changed file", exact: true })
    if (width === 1280) await summary.press("Enter")
    if (width === 390) await summary.click()
    const review = page
      .locator('[data-cm3-region="header"]')
      .getByRole("button", { name: "Toggle review", exact: true })
    await expect(review).toHaveAttribute("aria-pressed", "true")
    if (width === 1280)
      await expect(page.locator('[data-cm3-region="header"]').getByRole("tab", { name: /^Review/ })).toHaveAttribute(
        "aria-selected",
        "true",
      )
    await review.click()
    await expect(input).toBeVisible()
    await expect(input).toHaveText("Keep my follow-up")
  })
}

test("CM3 retains live streaming, tool settlement and interruption", async ({ page }) => {
  const reply = assistantMessage(
    [textPart("prt_qualification_stream", "Starting"), shell("prt_qualification_tool", "running")],
    { completed: false },
  )
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), reply],
    settings: { newLayoutDesigns: true, quietCompanion: true, shellToolPartsExpanded: true },
  })
  const text = page.locator('[data-timeline-part-id="prt_qualification_stream"]')
  await expect(text).toContainText("Starting")
  await timeline.send(partDelta("prt_qualification_stream", " streamed response"))
  await expect(text).toHaveCount(1)
  await expect(text).toContainText("Starting streamed response")
  await timeline.send(partUpdated(shell("prt_qualification_tool", "completed", "QUALIFICATION-COMPLETE")))
  await expect(page.locator('[data-timeline-part-id="prt_qualification_tool"]')).toContainText("QUALIFICATION-COMPLETE")
  await timeline.send(
    messageUpdated({
      ...completedAssistantInfo(reply.info),
      error: { name: "MessageAbortedError", data: { message: "Interrupted" } },
    }),
  )
  await timeline.send(status("idle"))
  await expect(page.getByText("Interrupted", { exact: true })).toBeVisible()
  await expect(page.locator('[data-component="prompt-input"][contenteditable="true"]')).toBeEditable()
  await expect(text).toContainText("Starting streamed response")
})

test("CM3 restores long-history scroll after visiting a new task", async ({ page }) => {
  await page.addInitScript((directory) => {
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        projects: { local: [{ worktree: directory, expanded: true }] },
        lastProject: { local: directory },
      }),
    )
  }, directory)
  await setupTimeline(page, {
    messages: historyMessages(80),
    settings: { newLayoutDesigns: true, quietCompanion: true },
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(700)
  const bottom = await scroller.evaluate((element) => element.scrollTop)
  await scroller.hover()
  await page.mouse.wheel(0, -700)
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(bottom - 100)
  const saved = await scroller.evaluate((element) => element.scrollTop)
  await page.locator(".cm3-sidebar").getByRole("button", { name: "New chat", exact: true }).click()
  await expect(page.locator('[data-cm3-thread="false"]')).toBeVisible()
  await page.goBack()
  await expect(page.locator('[data-cm3-thread="true"]')).toBeVisible()
  await expect
    .poll(() => scroller.evaluate((element, saved) => Math.abs(element.scrollTop - saved), saved))
    .toBeLessThan(20)
  await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThan(2)
})

test("CM3 keeps session rename and confirmed delete with failure recovery", async ({ page }) => {
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await page.addInitScript(() =>
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } })),
  )
  const removed: string[] = []
  const renamed: string[] = []
  let rejectDelete = true
  await page.route(`**/session/${fixture.sourceID}`, async (route) => {
    if (route.request().method() === "PATCH") {
      renamed.push(route.request().postDataJSON().title)
      return route.fulfill({ json: { ...fixture.sessions[0], title: renamed.at(-1) } })
    }
    if (route.request().method() === "DELETE") {
      removed.push(fixture.sourceID)
      return route.fulfill({
        status: rejectDelete ? 500 : 200,
        json: rejectDelete ? { message: "Qualification delete failed" } : true,
      })
    }
    return route.fallback()
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  const title = page.locator("[data-session-title]")
  await title.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  const editor = title.locator('input[data-slot="session-title-child"]')
  await editor.fill("Qualified session")
  await editor.press("Enter")
  await expectSessionTitle(page, "Qualified session")
  expect(renamed).toEqual(["Qualified session"])
  await title.getByRole("button", { name: "More options", exact: true }).click()
  await page.getByRole("menuitem", { name: /^Delete/ }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("Qualified session")
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(removed).toEqual([])
  for (const failure of [true, false]) {
    rejectDelete = failure
    await title.getByRole("button", { name: "More options", exact: true }).click()
    await page.getByRole("menuitem", { name: /^Delete/ }).click()
    await dialog.getByRole("button", { name: "Delete session", exact: true }).click()
    await expect(dialog).toHaveCount(0)
    if (failure) {
      await expectSessionTitle(page, "Qualified session")
      await expect(page.getByText("Qualification delete failed", { exact: true })).toBeVisible()
    }
  }
  expect(removed).toEqual([fixture.sourceID, fixture.sourceID])
  await expect(page).not.toHaveURL(stressSessionHref(fixture.sourceID))
})

test("CM3 tablet layout handles long Arabic labels, zoom and reduced motion", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 750 })
  await page.emulateMedia({ reducedMotion: "reduce" })
  await mockOpenCodeServer(page, {
    provider: fixture.provider,
    directory: fixture.directory,
    project: { ...fixture.project, name: "مشروع مراجعة التغييرات وتطوير تجربة المستخدم وإمكانية الوصول" },
    sessions: fixture.sessions,
    pageMessages,
  })
  await installStressSessionTabs(page)
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true, quietCompanion: true } }))
    localStorage.setItem("opencode.global.dat:language", JSON.stringify({ locale: "ar" }))
  })
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
  await page.locator("html").evaluate((element) => element.style.setProperty("zoom", "1.25"))
  const input = page.locator('[data-component="prompt-input"][contenteditable="true"]')
  await input.fill("احتفظ بهذه المسودة")
  await expect(input).toBeInViewport()
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true)
  const bounds = await input.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.width).toBeGreaterThan(150)
  await page.screenshot({ path: testInfo.outputPath("cm3-tablet-arabic-zoom.png") })
})
