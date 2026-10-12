import { CookieLoader } from "./cookie-loader"

export default {
  title: "UI/CookieLoader",
  id: "components-cookie-loader",
  component: CookieLoader,
  tags: ["autodocs"],
}

export const Basic = {
  render: () => <CookieLoader />,
}

export const Sizes = {
  render: () => (
    <div style={{ display: "flex", "flex-wrap": "wrap", gap: "24px", "align-items": "center" }}>
      <CookieLoader width={42} height={28} />
      <CookieLoader />
      <CookieLoader width={240} height={160} />
    </div>
  ),
}

export const Backgrounds = {
  render: () => (
    <div style={{ display: "flex", "flex-wrap": "wrap" }}>
      <div style={{ padding: "24px", background: "#f4eee5", color: "#6b4527" }}>
        <CookieLoader />
      </div>
      <div style={{ padding: "24px", background: "#17191b", color: "#edc38a" }}>
        <CookieLoader />
      </div>
    </div>
  ),
}
