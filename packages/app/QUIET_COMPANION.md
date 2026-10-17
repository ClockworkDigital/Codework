# Quiet Companion production interface

Quiet Companion (CM3) presents the production application. For CookieMonster, the existing persisted **New
Interface** setting selects it; disabling the setting returns to the previous presentation while retaining the
mounted session, project, server and draft. Unbranded OpenCode keeps its existing preference behavior.

## Production ownership

- Navigation uses the Home project/session controllers, server routing, real search, draft tabs and WPP status.
  Session rename and confirmed deletion remain in the production session heading menu.
- Landing and conversation use the production composer, model/agent options, attachments, submission, inbox,
  permissions, questions, timeline, streaming and scroll state. There is no second session implementation.
- Review uses the current session's production Changes panel. The timeline changed-files label opens that view,
  including on mobile. Browser uses the existing session-owned native panel and its existing consent boundaries.
- Themes, translated labels, RTL direction, keyboard controls and responsive navigation use the shared application
  infrastructure. No sample account, conversation, browser or file-change data ships in the interface.

## Intentional differences from the original design

The original Concept A design is preserved in Git history at `092adf78e7`. Its earlier standalone cream palette and
sample data are not the production target. The subsequent in-app design history explicitly adopted the Codex
references: white Light surfaces, coherent Dark surfaces, a project-aware landing, compact controls and shared
Light/Dark/System preferences. Qualification retains that direction rather than restoring the earlier cream shell.

Production uses real project/session navigation, the existing session action menu, permission controls, native Browser
tabs and production review modes instead of sample equivalents. Browser availability follows the desktop platform;
mobile uses the existing Changes surface. Production drafts and options follow the application's persistence and
submission rules rather than the sample composer's local arrays and attachment limits.

The standalone package and the unused in-app sample component are retired only after the production qualification
checks. Useful behavior is represented by the production tests below; design history remains available in Git.

## Focused qualification

From `packages/app`:

- `bun typecheck` and `bun run typecheck:e2e` check application and regression-test types.
- `bun run test:cm3:chrome` builds the app and checks navigation, draft/submission recovery, context tabs,
  streaming/tool settlement/interruption, rename/delete recovery, long-history restoration, responsive layouts,
  RTL/Arabic, zoom, reduced motion, Light/Dark contrast and the unbranded preference boundary.
- Run `regression/interface-toggle.spec.ts` with `VITE_CM_BRAND=1` to check both branded transition directions,
  editor identity, draft/route preservation, reload persistence and old-preference migration.
- `regression/session-request-docks.spec.ts` covers production permission/question docks and caret restoration;
  `regression/review-state-persistence.spec.ts` covers per-session review mode and selected-file restoration.
- Existing production-build navigation benchmarks and the timeline lifecycle, environment and scroll-interaction
  cases check blank frames, ordering, reduced motion, fractional scaling and user scrolling during tool updates.

The scoped browser component tests cover the shell, WPP event/recovery controls, browser tabs, native controls,
settings, panel requests and viewport bounds. From `packages/desktop`, `bun run scripts/browser-smoke.ts --rendering`
and `--tab-lifecycle` exercise the real Electron panel, native view retention/resizing, per-session tabs, grants and
consent/recovery boundaries in an isolated profile.

These checks use deterministic API/event fixtures and isolated Electron windows. They do not establish live WPP model
inference or packaged Windows behavior. The existing mounted browser preview/capture DOM fixture stalled when run
both in a group and alone; it was stopped and its unrelated implementation was left unchanged. Native rendering and
tab-lifecycle checks are separate evidence, not a claim that the stalled fixture passed.

The existing tall-row (`shell never rendered`) and nested-keyboard scroll scenarios also fail on the unchanged
baseline. These are recorded limits, not passing qualification evidence. The drag-selection probe waits for its
target to enter the viewport before reading its pointer coordinates. Navigation, lifecycle and environment cases pass; navigation probes retain
zero blank/unknown samples. Single-run timings are diagnostic rather than evidence of a speed improvement.
