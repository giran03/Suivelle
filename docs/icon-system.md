# Interface icons

Interface icons use the shared `Icon` component and a local Nerd Fonts symbol subset.
Text fonts, the Suivelle logo, user emoji, uploaded icons, charts, minimaps and drawn
connections keep their existing rendering. Shortcut key notation remains text.

## Registry and rendering

`src/components/iconGlyphs.json` maps semantic names to upstream Nerd Fonts names and
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

- Upstream: Nerd Fonts **v3.5.1**, `NerdFontsSymbolsOnly.zip`.
- URL: https://github.com/ryanoasis/nerd-fonts/releases/download/v3.5.1/NerdFontsSymbolsOnly.zip
- Archive SHA-256: `fdca3682534f6f65e1ccb2345b0362ccf67d9b8eca7c8025330946e93e2473bc`.
- Source: `SymbolsNerdFont-Regular.ttf`. Output: `public/fonts/suivelle-nerd-symbols.woff2`.
- The derivative is named **Suivelle Nerd Symbols**. Only mapped Material Design
  codepoints are shipped; unrelated upstream symbol families are excluded.
- Notices ship beside the font: `NERD-FONTS-LICENSE.txt`,
  `MATERIAL-DESIGN-LICENSE.txt`, and `APACHE-2.0.txt`.
- Normal app builds use the committed WOFF2; no Python, download or installed font
  is needed by users or the application build.

Both entry HTML files preload the font. `src/icons.css` loads it locally through
`@font-face`; the existing Tauri `font-src 'self'` policy permits it. `loadIconFont`
tracks readiness without blocking startup. A rejected or timed-out load switches
shared icons to short text fallbacks; accessible control labels remain intact.
Late successful loading restores the normal glyphs.

## Rebuild

Install build-only tools with `python -m pip install "fonttools[woff]==4.63.0" brotli==1.2.0`, then
run `python scripts/build-icon-font.py`. The script verifies the pinned archive,
checks source coverage, subsets and renames the font, verifies output coverage,
and regenerates `src/icon-symbols.css`. Do not hand-edit generated CSS.
Run `python scripts/build-icon-font.py --check` to verify local font coverage and
generated CSS without network access.

When adding a symbol, look up its `md-*` name and codepoint in the same release's
`glyphnames.json`, update the registry, then rebuild. Do not paste private-use
characters into components or use glyphs from a different release.

## Verification

- Registry/render tests, font failure tests, persisted page/workspace icon tests.
- Full frontend tests, typecheck, lint on touched code, and production Vite builds.
- Browser inspection in dark/light themes, sidebar rail, smaller viewports, high
  zoom, reduced motion, Node Map, canvas, settings and calendar navigation.
- Verify font load with no installed Nerd Fonts; block the font request to check
  failure behavior. Verify the packaged font and notices exist in build output.
- Keep SVG data visualizations and branding intact; keep user emoji/images intact.
