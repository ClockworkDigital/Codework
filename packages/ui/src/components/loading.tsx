import {
  createContext,
  createMemo,
  createUniqueId,
  useContext,
  splitProps,
  type ComponentProps,
  type ParentProps,
} from "solid-js"
import "./loading.css"

export type LoadingAnimationSet = {
  animations: readonly { id: string; src: string }[]
  still: string
}

const LoadingContext = createContext<LoadingAnimationSet>()

export function useLoadingAnimations() {
  return useContext(LoadingContext)
}

export function LoadingAnimationProvider(props: ParentProps<{ value?: LoadingAnimationSet }>) {
  return <LoadingContext.Provider value={props.value}>{props.children}</LoadingContext.Provider>
}

export function Loading(props: ComponentProps<"svg"> & { animationKey?: string; "data-component"?: string }) {
  const loading = useLoadingAnimations()
  const [local, rest] = splitProps(props, ["animationKey"])
  const choice = Math.random()

  const animation = createMemo(() => {
    const key = local.animationKey

    const index = key
      ? Array.from(key).reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) | 0, 0) >>> 0
      : Math.floor(choice * (loading?.animations.length ?? 0))

    return loading?.animations[index % loading.animations.length]
  })

  const filter = `loading-colour-${createUniqueId()}`

  return (
    <svg
      {...rest}
      width={props.width ?? 16}
      height={props.height ?? 16}
      viewBox="0 0 256 256"
      fill="currentColor"
      data-component={props["data-component"] ?? "loading"}
      data-loading-animation={animation()?.id}
      aria-hidden={props["aria-hidden"] ?? "true"}
    >
      <defs>
        <filter id={filter} x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
          {/* Shared SVG image resources keep duplicate indicators on the same animation timeline. */}
          <feFlood flood-color="currentColor" result="colour" />
          <feComposite in="colour" in2="SourceAlpha" operator="in" />
        </filter>
      </defs>
      <g filter={`url(#${filter})`}>
        <image data-slot="loading-motion" href={animation()?.src} width="256" height="256" />
        <image data-slot="loading-still" href={loading?.still} width="256" height="256" />
      </g>
    </svg>
  )
}
