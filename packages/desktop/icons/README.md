# Codework icons

The current desktop icons use Clockwork's supplied vector `clockwork-icon-2026-light.svg`, preserved on a
Midnight (`#07091B`) macOS-style tile. The vector master is `codework.svg`. Native `.icns`, `.ico` and PNG sizes are exported from it.
The same icon is used for the Dock, renderer splash, notifications and app-local web favicons.

Source artwork and the 2026 brand guide were supplied from `ClockworkOS/Logos`.
The Clockwork wordmark is used intact in the sidebar, with its built-in clear space. Codework's product
name is set separately in the supplied Anybody typeface; it does not replace letters in the company logo.
The font license is included at `packages/app/public/assets/Anybody-OFL.txt`.

All three desktop channels use this identity. `scripts/copy-icons.ts` stages the selected channel into
`resources/icons` before development or packaging. Unpackaged macOS uses the PNG `dock.png`; packaged
builds use `icon.icns`.
