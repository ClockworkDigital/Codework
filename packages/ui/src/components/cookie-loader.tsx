import { createUniqueId, type ComponentProps } from "solid-js"
import { paths } from "./phosphor"
import "./cookie-loader.css"

export function CookieLoader(props: Pick<ComponentProps<"svg">, "class" | "classList" | "style" | "width" | "height">) {
  const mask = `cookie-bites-${createUniqueId()}`

  return (
    <svg
      {...props}
      width={props.width ?? 120}
      height={props.height ?? 80}
      viewBox="-100 -24 456 304"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      data-component="cookie-loader"
      aria-hidden="true"
      ref={(element) => element.setAttribute("focusable", "false")}
    >
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256" mask-type="luminance">
          <rect width="256" height="256" fill="white" />
          <g fill="black">
            <g data-slot="bite" data-bite="1">
              <circle cx="214" cy="93" r="62" />
              <circle cx="211" cy="145" r="43" />
              <circle cx="247" cy="178" r="38" />
            </g>
            <g data-slot="bite" data-bite="2">
              <circle cx="107" cy="24" r="62" />
              <circle cx="130" cy="71" r="44" />
              <circle cx="171" cy="111" r="42" />
            </g>
            <g data-slot="bite" data-bite="3">
              <circle cx="29" cy="87" r="62" />
              <circle cx="48" cy="146" r="53" />
              <circle cx="61" cy="198" r="47" />
              <circle cx="108" cy="137" r="38" />
            </g>
            <rect data-slot="bite" data-bite="4" width="256" height="256" />
          </g>
        </mask>
      </defs>
      <g data-slot="cookie">
        <path mask={`url(#${mask})`} d={paths.cookie} />
      </g>
      <g data-slot="crumbs" data-bite="1">
        <path d="m195 125 8-3 4 7-8 5z" />
        <circle cx="223" cy="158" r="4" />
        <circle cx="194" cy="163" r="3" />
      </g>
      <g data-slot="crumbs" data-bite="2">
        <path d="m103 63 7-4 5 7-7 4z" />
        <circle cx="137" cy="93" r="4" />
        <circle cx="88" cy="89" r="3" />
      </g>
      <g data-slot="crumbs" data-bite="3">
        <path d="m59 156 8-3 3 8-7 3z" />
        <circle cx="83" cy="189" r="4" />
        <circle cx="47" cy="192" r="3" />
      </g>
      <g data-slot="crumbs" data-bite="4">
        <path d="m132 190 8-4 5 7-8 5z" />
        <circle cx="167" cy="202" r="5" />
        <circle cx="116" cy="216" r="3" />
        <circle cx="179" cy="176" r="3" />
      </g>
    </svg>
  )
}
