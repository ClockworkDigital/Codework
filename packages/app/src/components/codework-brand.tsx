import { useLanguage } from "@/context/language"

export function CodeworkBrand(props: { class?: string }) {
  const language = useLanguage()
  return (
    <div data-component="codework-banner" class={props.class}>
      <span>{language.t("quietCompanion.brand")}</span>
    </div>
  )
}
