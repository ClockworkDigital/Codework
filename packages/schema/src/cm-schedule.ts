import { Rpc } from "./rpc.js"

export const CmScheduleRpc = Rpc.define({
  id: "cookiemonster.schedule",
  methods: {
    list: { input: { type: "object", properties: {} }, output: {} },
    manage: {
      input: {
        type: "object",
        properties: { action: { type: "string" }, id: { type: "string" }, definition: {} },
        required: ["action"],
      },
      output: {},
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          state: { type: "string" },
          detail: { type: "string" },
        },
        required: ["id", "name", "state"],
      },
    },
  },
})
