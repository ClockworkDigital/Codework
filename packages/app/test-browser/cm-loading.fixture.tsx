import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { render } from "solid-js/web"
import { LoadingAnimationProvider } from "@opencode/ui/loading"
import { Spinner } from "@opencode/ui/spinner"
import { Loader } from "@opencode/ui/loader"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { cmLoading } from "../src/cookiemonster/cm-loading"

function Fixture() {
  const [state, setState] = createStore({ late: false, alternate: false, light: false })

  const indicator = (index: number) => (
    <SessionProgressIndicatorV2 animationKey={`session-${index + (state.alternate ? 1 : 0)}`} width={64} height={64} />
  )

  return (
    <main style={{ color: state.light ? "rgb(215, 225, 235)" : "rgb(17, 91, 177)", padding: "24px" }}>
      <style>{`[data-component="session-progress-indicator-v2"] { color: inherit; }
        section { display:flex; } svg { flex-shrink:0; }`}</style>
      <button id="late" onClick={() => setState("late", !state.late)}>
        Toggle copies
      </button>
      <button id="session" onClick={() => setState("alternate", !state.alternate)}>
        Change session
      </button>
      <button id="theme" onClick={() => setState("light", !state.light)}>
        Change theme
      </button>
      <section id="stock">
        <SessionProgressIndicatorV2 />
      </section>
      <LoadingAnimationProvider value={cmLoading}>
        <section id="project">
          <For each={[0, 1, 2, 3, 4, 5]}>{indicator}</For>
        </section>
        <Show when={state.late}>
          <section id="recent">
            <For each={[0, 1, 2, 3, 4, 5]}>{indicator}</For>
          </section>
          <section id="tabs">
            <For each={[0, 1, 2, 3, 4, 5]}>{indicator}</For>
          </section>
        </Show>
        <section id="adapters">
          <Spinner />
          <Loader />
        </section>
      </LoadingAnimationProvider>
    </main>
  )
}

render(() => <Fixture />, document.getElementById("root")!)
