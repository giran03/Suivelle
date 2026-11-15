# Interface icons

Interface icons use the shared `Icon` component and a local Google Material Symbols subset.
Text fonts, the Suivelle logo, user emoji, uploaded icons, charts, minimaps and drawn
connections keep their existing rendering. Shortcut key notation remains text.

## Registry and rendering

`src/components/iconGlyphs.json` maps semantic names to Material Symbols names and
Unicode codepoints. Every glyph comes from the Material Design family to keep the
visual weight consistent. `IconName` and `isIconName` derive from the registry.
Keep existing names stable: page `icon:star` and workspace `symbol:star` strings are
persisted user choices. There is no database migration.

`Icon` renders a decorative `i.app-icon`, with the glyph supplied by `::before`.
Glyphs do not enter button text, type-ahead matching, selection or clipboard text.
Accessible labels belong to the containing control. Keep title hints on icon-only
controls. Size defaults to 16px; fixed square boxes inherit semantic color. `filled`
selects a filled star variant for favorites; other glyphs have their authored weight.

Canvas tools retain semantic aliases but use the same renderer. Calendar navigation
and popover controls use FullCalendar's content hooks rather than dependency patches.
Checkboxes and native select indicators use generated CSS glyph variables.

Icon styling targets `.app-icon`; reserve SVG selectors for actual drawings and
branding. Icon swaps and chevron rotations use the existing motion tokens. Success
feedback retains its settle/fade motion without SVG stroke animation.

## Local font and provenance

- Upstream: the `material-symbols` npm package (Google Material Symbols, Apache 2.0), Outlined variable font.
- Output: `public/fonts/material-symbols-outlined.woff2`, about 20 KB. Only the glyphs in the registry are
  shipped; the weight (100-700) and fill (0-1) axes are kept, grade and optical size are pinned.
- Weight and fill follow `--icon-weight` (default 300) and `--icon-fill` (default 0). The favourite star is solid.
- `APACHE-2.0.txt` ships beside the font.
- Normal app builds use the committed WOFF2; no Python, download or installed font is needed.

Both entry HTML files preload the font. `src/icons.css` loads it through `@font-face`; `loadIconFont` tracks
readiness and switches to short text fallbacks if it fails to load.

## Rebuild

Install build-only tools: `npm i material-symbols --prefix <temp dir>` and
`python -m pip install "fonttools[woff]" brotli`, then run
`python scripts/build-icon-font.py <temp dir>/node_modules/material-symbols/material-symbols-outlined.woff2`.
The script looks up each codepoint, subsets the font and regenerates `src/icon-symbols.css`.
To add or change a symbol, edit the `name` in the registry and rebuild. Do not hand-edit generated CSS.
