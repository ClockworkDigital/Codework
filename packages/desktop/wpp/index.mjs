import { startWppBridge } from "@cookiemonster/wpp"
import { wppAuth, openWppLogin, toggleWppLogin } from "@cookiemonster/wpp/session"
import { toggleWorkerWindows } from "@cookiemonster/wpp/worker-pool"
import { DEFAULT_MODEL_ID } from "@cookiemonster/wpp/proxy/modelProfiles.mjs"
import { isLoggedWorker, setWorkerLogWriter } from "@cookiemonster/wpp/worker-logging"
import { attachWppLoginControls } from "../src/main/wpp-integration/login-controls"

export const wpp = {
  model: `cookiemonster/${DEFAULT_MODEL_ID}`,
  auth: wppAuth,
  toggleLogin: toggleWppLogin,
  toggleWindows: toggleWorkerWindows,
  isLoggedWorker,
  setWorkerLogWriter,
  async start(chatMode, onAuth) {
    wppAuth.subscribe(onAuth)
    await startWppBridge({
      chatMode,
      attachLoginControls: attachWppLoginControls,
      openLogin: () => void openWppLogin(),
      checkAuth: () => wppAuth.check(),
    })
  },
}
