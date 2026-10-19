import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const owner = { sessionID: Schema.String }

export const CmBrowserRpcs = RpcGroup.make(
  Rpc.make("CmBrowserCommand", { payload: { ...owner, command: Schema.String }, success: Schema.String }),
  Rpc.make("CmBrowserViewport", { payload: { ...owner, viewport: Schema.String } }),
  Rpc.make("CmBrowserContext", {
    payload: { ...owner, tabID: Schema.String, operation: Schema.Literals(["selection", "pick", "screenshot"]) },
    success: Schema.String,
  }),
  Rpc.make("CmBrowserPanelCurrent", {
    payload: { id: Schema.String, sessionID: Schema.String },
    success: Schema.Boolean,
  }),
  Rpc.make("CmBrowserPanelAcknowledge", { payload: { acknowledgement: Schema.String }, success: Schema.Boolean }),
  Rpc.make("CmBrowserLinkContext", { payload: { sessionID: Schema.NullOr(Schema.String), lease: Schema.String } }),
  Rpc.make("CmWppLogin"),
  Rpc.make("CmWppToggleWindows"),
  Rpc.make("CmWppAuth", { payload: { check: Schema.Boolean }, success: Schema.String }),
)
