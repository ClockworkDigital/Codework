import { expect, test } from "bun:test"
import { join } from "node:path"
import { mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "./fixture/tmpdir"
import { skills } from "../src/cm-ae/skills"
import { ManagedSkill } from "../src/cm-ae/managed"

const draft = {
  name: "brand-motion",
  description: "Brand title motion",
  instructions: "Keep the logo fixed.",
  scope: "workspace" as const,
}

test("AE reviewed skill writes pin content, preserve backups and reject changed or reused receipts", async () => {
  await using root = await tmpdir("cm-ae-skills-")
  const service = skills({
    directory: root.path,
    config: join(root.path, "config"),
    list: async () => [],
    changed: async () => {},
  })
  const review = await service.request("review", draft)
  const receipt = ManagedSkill.Review.make(review as typeof ManagedSkill.Review.Type)
  await service.request("create", { ...draft, token: receipt.token })
  const file = join(root.path, ".opencode", "skills", draft.name, "SKILL.md")
  const original = await Bun.file(file).text()
  expect(original).toBe(ManagedSkill.validate(draft))
  await expect(service.request("create", { ...draft, token: receipt.token })).rejects.toThrow("Review expired")
  const selected = await ManagedSkill.snapshot(file)
  const replacement = { ...draft, instructions: "Keep the logo centered." }
  const edit = (await service.request("manage", {
    action: "review",
    selected,
    operation: "edit",
    draft: replacement,
  })) as typeof ManagedSkill.Managed.Type
  await expect(
    service.request("manage", { action: "apply", selected, operation: "edit", draft, token: edit.token }),
  ).rejects.toThrow("Review expired")
  expect(await Bun.file(file).text()).toBe(original)
  const approved = (await service.request("manage", {
    action: "review",
    selected,
    operation: "edit",
    draft: replacement,
  })) as typeof ManagedSkill.Managed.Type
  const updated = (await service.request("manage", {
    action: "apply",
    selected,
    operation: "edit",
    draft: replacement,
    token: approved.token,
  })) as typeof ManagedSkill.Managed.Type
  expect(await Bun.file(updated.backup!).text()).toBe(original)
  expect(await Bun.file(file).text()).toContain(replacement.instructions)
  await expect(service.resolve(selected)).rejects.toThrow("changed")
})

test("AE reviewed skill creation refuses a symlinked storage root", async () => {
  await using root = await tmpdir("cm-ae-skills-link-")
  await mkdir(join(root.path, ".opencode"))
  await mkdir(join(root.path, "elsewhere"))
  await symlink(join(root.path, "elsewhere"), join(root.path, ".opencode", "skills"), "dir")
  const service = skills({
    directory: root.path,
    config: join(root.path, "config"),
    list: async () => [],
    changed: async () => {},
  })
  const review = (await service.request("review", draft)) as typeof ManagedSkill.Review.Type
  await expect(service.request("create", { ...draft, token: review.token })).rejects.toThrow("linked or non-directory")
  expect(await Bun.file(join(root.path, "elsewhere", draft.name, "SKILL.md")).exists()).toBe(false)
})
