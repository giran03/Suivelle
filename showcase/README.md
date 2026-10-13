# Suivelle motion showcase

A read-only showcase of Suivelle, plus a 60 fps product film.

- `suivelle-motion-showcase.mp4`: 1920x1080, 60 fps, about two minutes. Every motion in it is the real app's.
- `mock/`: an in-memory stand-in for the Rust backend (workspace "Hollow Orbit": pages, a sprint database with 18 records, a dashboard, search). The frontend in `src/` is untouched; only `@tauri-apps/api/core` is swapped for `mock/tauri-core.ts`.
- `tools/`: the recorder. It drives the real UI with a visible cursor, captures a CDP screencast of headless Chrome, and assembles the MP4 with ffmpeg (virtual camera moves included).

## Open the mock-up

```bash
npx vite build --config showcase/vite.config.ts
npx vite preview --config showcase/vite.config.ts
```

Then open http://localhost:1488. Browse pages and records, press Ctrl+K to search, explore board/table/calendar/timeline views and dashboards, or open Settings to try themes and motion preferences.

The showcase blocks content creation, edits, deletion, reordering, imports, uploads, and schema changes. Page text remains selectable and links remain navigable. Filters, sorting, column display, and appearance preferences are available for exploration; sample content stays unchanged.

(The mock-up is served from a production build. In dev mode React StrictMode double-mounts the editor's block-handle plugin; that is a dev-only quirk of the app, not of the mock.)

## Re-record the film

Needs Chrome and ffmpeg on the machine, and the preview server above running.

```bash
cd showcase/tools
npm install
node film.mjs <frames-dir>
node assemble.mjs <frames-dir> ../suivelle-motion-showcase.mp4
```

`film.mjs` is the original storyboard (scenes, captions, camera). Its editing scenes predate the read-only showcase and need a revised storyboard before re-recording. `presenter.js` is the film-only layer: cursor, click rings, motion captions, title and end cards. It is injected by the recorder and is not part of the product UI.
