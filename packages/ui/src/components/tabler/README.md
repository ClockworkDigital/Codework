# Tabler interface icons

The shared catalogue uses Tabler Icons outline artwork under the MIT licence.
`provenance.json` pins the source package, its integrity hash and the mapping from
existing Codework icon names. Brand artwork remains separate.

The generator expands Tabler's 2-unit round strokes into filled paths, then scales
the 24-unit artwork to the existing 256-unit view box. This keeps existing sprite,
inline SVG, colour inheritance and sidebar mirroring behaviour compatible.
`../phosphor.ts` is a compatibility export; it also returns Tabler artwork.

To regenerate from the repository root:

```sh
python3 -m venv /tmp/codework-tabler-venv
/tmp/codework-tabler-venv/bin/pip install skia-python==144.1 fonttools==4.60.2
/tmp/codework-tabler-venv/bin/python packages/ui/script/build-tabler.py
bunx prettier --write packages/ui/src/components/tabler.ts
```

These Python packages are only needed to regenerate the assets. Normal builds
have no new dependency or network requirement. Keep `LICENSE` with distributions.
