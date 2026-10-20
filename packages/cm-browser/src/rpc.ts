import { Rpc } from "@opencode/schema/rpc"
import { z } from "zod"
import { MAX_REQUEST_BYTES } from "./protocol"

const connectionID = z.string().regex(/^[a-f\d-]{36}$/)
const message = z.string().max(20 * 1024 * 1024)
const requestMessage = z
  .string()
  .max(MAX_REQUEST_BYTES)
  .refine((value) => Buffer.byteLength(value) <= MAX_REQUEST_BYTES, "Browser request exceeds 64 KiB")
export const BrowserRpc = Rpc.define({
  id: "cookiemonster.browser",
  methods: {
    attach: { input: z.object({ connectionID }), output: z.null() },
    detach: { input: z.object({ connectionID }), output: z.null() },
    result: { input: z.object({ connectionID, message }), output: z.null() },
  },
  events: {
    attached: { schema: z.object({ connectionID }) },
    request: { schema: z.object({ connectionID, message: requestMessage }) },
  },
})
