import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { build } from "vite"
import solid from "vite-plugin-solid"
import { browser } from "../src/cookiemonster/browser/en"

test("mounted site inspection exposes failed refreshes over retained data and clears them on retry or navigation", async () => {
  const directory = await mkdtemp(resolve("test-browser/.site-inspection-"))
  const host = document.createElement("div")
  document.body.append(host)
  let dispose = () => {}

  try {
    await build({
      configFile: false,
      root: resolve("."),
      logLevel: "warn",
      plugins: [
        {
          name: "site-inspection-fixture",
          enforce: "pre",
          resolveId(id) {
            for (const name of ["site-inspection-fixture", "@/runtime/i18n/language"]) {
              if (id === name || id.replaceAll("\\", "/") === resolve(name.replace("@/", "src/")).replaceAll("\\", "/"))
                return "\0" + name
            }
          },
          load(id) {
            if (id === "\0@/runtime/i18n/language")
              return `import { browser } from ${JSON.stringify(resolve("src/cookiemonster/browser/en.ts"))};
            export const useLanguage = () => ({intl:()=>"en-US", t:(key, params={})=>Object.entries(params).reduce((text,[name,value])=>text.replaceAll("{{"+name+"}}",String(value)),browser[key] ?? key)});`

            if (id === "\0site-inspection-fixture")
              return `
            import { createComponent } from "solid-js";
            import { createStore } from "solid-js/store";
            import { render } from "solid-js/web";
            import { BrowserSite } from ${JSON.stringify(resolve("src/cookiemonster/browser/browser-site.tsx"))};
            export function mount(host, initialFailure=false) {
              const [state,setState]=createStore({result:initialFailure?"false":"true",tab:{id:"tab",url:"https://first.example/page",agentAccess:true,siteData:initialFailure?undefined:{origin:"https://first.example",cookies:1,usage:1024,storage:[]}}});
              const dispose=render(()=>createComponent(BrowserSite,{get tab(){return state.tab},profile:{},busy:false,command:async()=>{if(state.result==="reject")throw Error("inspection failed");return state.result!=="false"}}),host);
              return {dispose,result:value=>setState("result",value),tab:value=>setState("tab",value)};
            }`
          },
        },
        solid(),
      ],
      resolve: { alias: { "@": resolve("src") } },
      build: {
        outDir: directory,
        emptyOutDir: false,
        minify: false,
        lib: { entry: "site-inspection-fixture", formats: ["es"], fileName: () => "fixture.mjs" },
      },
    })
    const fixture = await import(pathToFileURL(join(directory, "fixture.mjs")).href)
    const mounted = fixture.mount(host)
    dispose = mounted.dispose
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

    const refresh = () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === browser["browser.site.refresh"])!
        .click()

    await tick()
    expect(host.textContent).toContain("Cookies matching this page: 1")

    for (const failure of ["false", "reject"]) {
      mounted.result(failure)
      refresh()
      await tick()
      expect(host.textContent).toContain(browser["browser.site.inspectFailed"])
      expect(host.textContent).toContain(browser["browser.site.stale"])
      expect(host.textContent).toContain("Cookies matching this page: 1")
    }

    mounted.result("true")
    mounted.tab({ siteData: { origin: "https://first.example", cookies: 2, usage: 1024, storage: [] } })
    refresh()
    await tick()
    expect(host.textContent).toContain("Cookies matching this page: 2")
    expect(host.textContent).not.toContain(browser["browser.site.inspectFailed"])
    expect(host.textContent).not.toContain(browser["browser.site.stale"])
    mounted.tab({ url: "https://second.example/" })
    await tick()
    expect(host.textContent).toContain(browser["browser.site.inspecting"])
    expect(host.textContent).not.toContain("Cookies matching this page:")
    dispose()
    host.replaceChildren()
    const initial = fixture.mount(host, true)
    dispose = initial.dispose
    await tick()
    expect(host.textContent).toContain(browser["browser.site.inspectFailed"])
    expect(host.textContent).not.toContain(browser["browser.site.stale"])
    expect(host.textContent).not.toContain(browser["browser.site.inspecting"])
  } finally {
    dispose()
    host.remove()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
