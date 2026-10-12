import { describe, expect, test } from "bun:test"
import vm from "node:vm"
import {
  agentChatFrame,
  agentChatLaunchExpression,
  agentChatSelectedExpression,
  isAgentChatUrl,
  openAgentChat,
} from "./agent-chat"

describe("published WPP agent chat", () => {
  test.each(["loading", "interactive"])(
    "does not launch before the roster document is complete at %s",
    (readyState) => {
      const h = harness(["CM_Astra"])
      h.state.readyState = readyState
      h.launch("CM_Astra")
      h.launch("CM_Astra")
      expect(h.cards[0].button.clicks).toBe(0)
      expect(h.chat.clicks).toBe(0)
      h.state.readyState = "complete"
      h.launch("CM_Astra")
      h.state.readyState = readyState
      h.launch("CM_Astra")
      expect(h.chat.clicks).toBe(0)
      h.state.readyState = "complete"
      h.launch("CM_Astra")
      expect(h.chat.clicks).toBe(1)
    },
  )

  test("recognizes the agent chat, excluding the editor and assistant panel", () => {
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?model=agent")).toBe(true)
    expect(isAgentChatUrl("https://open-web-agent-builder-cs.wpp.ai/agent/project/edit/agent")).toBe(false)
    expect(isAgentChatUrl("https://open-web-assistant-cs.wpp.ai/chat/project")).toBe(false)
  })

  test("opens only the exact agent's menu, then its Chat action", () => {
    const h = harness(["CM_Sol_High", "CM_Sol_XHigh"])
    expect(h.launch("CM_Sol_High")).toBe("waiting")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([1, 0])
    expect(h.chat.clicks).toBe(0)
    h.state.menuVisible = true
    expect(h.launch("CM_Sol_High")).toBe("clicked")
    expect(h.chat.clicks).toBe(1)
  })

  test("opens a hover-triggered agent menu before selecting Chat", () => {
    const h = harness(["CM_Sol_High", "CM_Astra"])
    expect(h.launch("CM_Astra")).toBe("waiting")
    expect(h.launch("CM_Astra")).toBe("clicked")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([0, 1])
    expect(h.chat.clicks).toBe(1)
  })

  test("does not open an unrelated menu when the agent is missing or duplicated", () => {
    const h = harness(["CM_Sol_High", "CM_Sol_High"])
    expect(h.launch("CM_Missing")).toBe("waiting")
    expect(h.launch("CM_Sol_High")).toBe("ambiguous")
    expect(h.cards.map((card) => card.button.clicks)).toEqual([0, 0])
    expect(h.chat.clicks).toBe(0)
  })

  test("proves the locked composer agent before reusing its window", () => {
    const context = vm.createContext({ document: { querySelectorAll: () => [{ textContent: "CM_Sol_High" }] } })
    expect(vm.runInContext(agentChatSelectedExpression("CM_Sol_High"), context)).toBe(true)
    expect(vm.runInContext(agentChatSelectedExpression("CM_Sol_XHigh"), context)).toBe(false)
  })
})

describe("dedicated chat startup lifecycle", () => {
  test("waits for full roster load and asynchronous card/action readiness", async () => {
    const h = harness(["CM_Astra"])
    h.state.readyState = "loading"
    h.state.hoverOpensMenu = false
    h.cards[0].button.disabled = true
    h.chat.disabled = true
    let time = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time <= 1000) expect(h.cards[0].button.clicks).toBe(0)
        if (time <= 1500) expect(h.chat.clicks).toBe(0)
        if (time >= 500) h.state.readyState = "complete"
        if (time >= 1000) h.cards[0].button.disabled = false
        if (time >= 1250) h.state.menuVisible = true
        if (time >= 1500) h.chat.disabled = false
        if (h.chat.clicks) {
          roster.url = "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational"
          h.state.selected = "CM_Astra"
        }
      },
      timeoutMs: 3000,
    })
    expect(h.cards[0].button.clicks).toBe(1)
    expect(h.chat.clicks).toBe(1)
  })

  test("waits for accepted navigation delayed beyond six seconds without another Chat click", async () => {
    const h = harness(["CM_Astra"])
    let time = 0
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => {
        const before = h.chat.clicks
        const result = h.execute(source)
        if (h.chat.clicks !== before) h.state.menuVisible = false
        return result
      },
    }
    await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (time >= 6500) {
          roster.url = "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational"
          h.state.selected = time >= 7000 ? "CM_Astra" : "CM_Other"
        }
      },
      timeoutMs: 10000,
    })
    expect(h.chat.clicks).toBe(1)
    expect(h.cards[0].button.clicks).toBe(1)
    expect(time).toBe(7000)
  })

  test.each(["unchanged", "temporary-disabled", "unrelated-menu"])(
    "dispatches a dropped Chat click once and waits the full deadline with %s controls",
    async (controls) => {
      const h = harness(["CM_Astra"])
      let time = 0
      const roster = {
        url: "https://open-web-agent-builder-cs.wpp.ai/project/agents?token=secret",
        executeJavaScript: async (source: string) => {
          const before = h.chat.clicks
          const result = h.execute(source)
          if (h.chat.clicks !== before) h.state.menuVisible = false
          return result
        },
      }
      const error = await openAgentChat({ mainFrame: { framesInSubtree: [roster] } }, "CM_Astra", {
        now: () => time,
        sleep: async (ms) => {
          time += ms
          if (controls === "temporary-disabled") h.cards[0].button.disabled = time >= 500 && time < 1000
          if (controls === "unrelated-menu" && time >= 500) h.state.otherMenuVisible = true
        },
        timeoutMs: 12000,
      }).catch((error: unknown) => error)
      expect(error).toMatchObject({
        type: "o1_code_agent_chat_timeout",
        statusCode: 502,
        diagnostics: { phase: "chat-navigation", chatClicks: 1 },
      })
      expect(h.chat.clicks).toBe(1)
      expect(h.cards[0].button.clicks).toBe(1)
      expect(h.otherChat.clicks).toBe(0)
      expect(time).toBe(12000)
      expect(JSON.stringify(error)).not.toContain("secret")
      expect(JSON.stringify(error)).not.toContain("https://")
    },
  )

  test("launches from the roster and waits for the exact published agent without touching the side panel", async () => {
    const h = harness(["CM_Astra"])
    let time = 0
    let launches = 0
    let selected = false
    const sidePanel = {
      url: "https://open-web-assistant-cs.wpp.ai/chat",
      executeJavaScript: async () => {
        throw new Error("side panel must not receive commands")
      },
    }
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?model=agent&resultId=turn",
      executeJavaScript: async (source: string) => {
        const context = vm.createContext({
          document: { querySelectorAll: () => (selected ? [{ textContent: "CM_Astra" }] : []) },
        })
        return vm.runInContext(source, context)
      },
    }
    const roster = {
      url: "https://open-web-agent-builder-cs.wpp.ai/project/agents",
      executeJavaScript: async (source: string) => {
        launches += 1
        const result = h.execute(source)
        h.state.menuVisible = true
        return result
      },
    }
    const contents = { mainFrame: { framesInSubtree: [sidePanel, roster] } }
    await openAgentChat(contents, "CM_Astra", {
      now: () => time,
      sleep: async (ms) => {
        time += ms
        if (h.chat.clicks) contents.mainFrame.framesInSubtree = [sidePanel, chat]
        if (time >= 3000) selected = true
      },
      timeoutMs: 4000,
    })
    expect(launches).toBe(2)
    expect(h.chat.clicks).toBe(1)
    expect(time).toBe(3000)
    expect(agentChatFrame(contents)).toBe(chat)
  })

  test("reuses the exact agent chat when resultId changes", async () => {
    const chat = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational?resultId=first",
      executeJavaScript: async (source: string) =>
        vm.runInNewContext(source, {
          document: { querySelectorAll: () => [{ textContent: "CM_Astra" }] },
        }),
    }
    const contents = { mainFrame: { framesInSubtree: [chat] } }
    await openAgentChat(contents, "CM_Astra")
    chat.url = chat.url.replace("first", "second")
    expect(agentChatFrame(contents)).toBe(chat)
    await openAgentChat(contents, "CM_Astra")
  })

  test.each(["missing", "wrong-agent"])("times out without submitting when %s", async (mode) => {
    const h = harness(["CM_Astra"])
    h.state.selected = "CM_Other"
    let time = 0
    const frame = {
      url:
        mode === "missing"
          ? "https://open-web-assistant-cs.wpp.ai/chat"
          : "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async (source: string) => h.execute(source),
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame] } }, "CM_Astra", {
        now: () => time,
        sleep: async (ms) => {
          time += ms
        },
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      type: "o1_code_agent_chat_timeout",
      statusCode: 502,
      diagnostics: { phase: mode === "missing" ? "waiting-roster" : "verifying-agent", chatClicks: 0 },
    })
    expect(time).toBe(1000)
    expect(h.chat.clicks).toBe(0)
    expect(h.cards[0].button.clicks).toBe(0)
  })

  test.each(["/chat/project/foundational", "/project/agents"])("rejects ambiguous frames at %s", async (path) => {
    const frame = {
      url: `https://open-web-agent-builder-cs.wpp.ai${path}`,
      executeJavaScript: async () => {
        throw new Error("ambiguous frames must not receive commands")
      },
    }
    await expect(
      openAgentChat({ mainFrame: { framesInSubtree: [frame, { ...frame }] } }, "CM_Astra"),
    ).rejects.toMatchObject({ type: "o1_code_wrong_agent" })
  })

  test("requires exactly one dedicated frame and excludes editors, malformed URLs and side panels", () => {
    const frame = {
      url: "https://open-web-agent-builder-cs.wpp.ai/chat/project/foundational",
      executeJavaScript: async () => true,
    }
    for (const url of [
      "invalid",
      "https://open-web-agent-builder-cs.wpp.ai/agent/project/edit/agent",
      "https://open-web-assistant-cs.wpp.ai/chat",
      "https://open-web-agent-builder-cs.wpp.ai.evil.test/chat/project/foundational",
    ]) {
      expect(() => agentChatFrame({ mainFrame: { framesInSubtree: [{ ...frame, url }] } })).toThrow(
        "o1_code_thread_desync",
      )
    }
    expect(() => agentChatFrame({ mainFrame: { framesInSubtree: [frame, { ...frame }] } })).toThrow(
      "o1_code_thread_desync",
    )
  })

  test("fails closed when another menu was already open", () => {
    const h = harness(["CM_Astra"])
    h.state.menuVisible = true
    expect(h.launch("CM_Astra")).toBe("blocked")
    expect(h.cards[0].button.clicks).toBe(0)
    expect(h.chat.clicks).toBe(0)
  })
})

function harness(names: string[]) {
  const state = {
    menuVisible: false,
    otherMenuVisible: false,
    hoverOpensMenu: true,
    readyState: "complete",
    selected: "",
  }
  const control = (textContent = "") => ({
    textContent,
    clicks: 0,
    dataset: {} as Record<string, string>,
    getAttribute: () => null,
    disabled: false,
    click() {
      this.clicks += 1
    },
    dispatchEvent(event: { type: string }) {
      if (event.type === "mouseover" && state.hoverOpensMenu) state.menuVisible = true
      return true
    },
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  })
  const cards = names.map((name) => ({
    ...control(),
    button: control(),
    querySelector(selector: string) {
      return selector === ".agent-card-title__name" ? { textContent: name } : this.button
    },
  }))
  const chat = control("Chat")
  const otherChat = control("Chat")
  const context = vm.createContext({
    document: {
      get readyState() {
        return state.readyState
      },
      querySelectorAll: (selector: string) => {
        if (selector === ".agent-card") return cards
        if (selector === "[data-testid='chat-model-button']") {
          return state.selected ? [{ textContent: state.selected }] : []
        }
        return state.otherMenuVisible ? [otherChat] : state.menuVisible ? [chat] : []
      },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    MouseEvent: class {
      constructor(readonly type: string) {}
    },
  })
  return {
    state,
    cards,
    chat,
    otherChat,
    execute: (source: string) => vm.runInContext(source, context),
    launch: (agent: string) => vm.runInContext(agentChatLaunchExpression(agent), context),
  }
}
