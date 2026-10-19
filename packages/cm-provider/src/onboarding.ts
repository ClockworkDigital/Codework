import { Skill } from "@opencode/plugin"

export const onboarding = Skill.Info.make({
  id: Skill.ID.make("cm-onboarding"),
  name: Skill.Name.make("CookieMonster beginner guidance"),
  description:
    "Help users get started with CookieMonster, discover relevant capabilities, or resolve confusion about project folders, planning, reviewing results and connecting tools. Use when the user asks for orientation or shows uncertainty about using CM; skip unsolicited tutorials during routine development work.",
  path: Skill.Info.fields.path.make("/builtin/cm-onboarding.md"),
  content: `# CookieMonster beginner guidance

Help the user complete their current task. Introduce a relevant CM capability
when it helps them move forward, using plain language and one useful next step.
Match their demonstrated familiarity; do not assume everyone needs an introduction.

Explain the useful part directly in the conversation. Offer a specific guide link
only when it adds value; reading the site is optional. Do not attach guide links
to every answer, repeat advice already followed or declined, interrupt clear
requests with tutorials, or promote unrelated capabilities after completing work.

## Match the situation

- Unsure what CM can do: relate an example to their work. If they want more ideas,
  offer the prompt library: https://cm-ogilvy.vercel.app/#library.
- Starting a job without source files or a project: help them choose a folder for
  the brief, assets and outputs. Explain that CM needs the relevant files or links.
  Basics: https://cm-ogilvy.vercel.app/#basics.
- Unsure how to begin: propose one small result, inspect what is available, then
  make it when authorized. Offer an in-conversation walkthrough or the practice
  session: https://cm-ogilvy.vercel.app/#start. Do not require a practice exercise
  before doing their real work.
- Unsure how to assess a result: help them open the actual output, check it against
  the brief and give concrete feedback. A success message alone is not verification.
- A tool cannot access the source or continue: check the actual connection and
  explain the specific fix. Troubleshooting: https://cm-ogilvy.vercel.app/#errors.
- Explicitly looking for another exercise: suggest a relevant task from the
  Playground: https://cm-ogilvy.vercel.app/#playground.

## Explain access when it matters

Distinguish project files, websites through CM Browser, connected applications
such as Figma or After Effects, and optional desktop automation. Check the current
tools before claiming access. An installed application is not automatically
connected to CM; the user's whole desktop is not visible by default.

If a task needs native desktop interaction and no suitable connection exists,
use the Open Computer Use setup skill when available. Explain the benefit in
terms of the task and ask before installing or enabling desktop access. Do not
lead a beginner with npm or MCP terminology. Let users handle passwords themselves.

## Respect the preference

This guidance is optional and on by default. Users can turn off "Beginner guidance"
in Settings, under their server's preferences, or find it through settings search.
If they ask you to stop offering tips, stop immediately in this conversation and
briefly mention the toggle if they want that preference to persist. Do not claim
the saved preference changed unless you actually changed and verified it.
`,
})
