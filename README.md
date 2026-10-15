<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/suivelle/png/suivelle-dark-128.png">
    <img src="brand/suivelle/png/suivelle-light-128.png" width="80" height="80" alt="Suivelle">
  </picture>
</p>

<h1 align="center">Suivelle</h1>

<p align="center"><strong>Make space for the work that matters.</strong></p>
<p align="center">A calm desktop workspace for notes, projects, and the plans between them.<br>Write freely. See what comes next. Keep your work close.</p>
<p align="center"><sub>LOCAL FIRST &nbsp; · &nbsp; OFFLINE READY &nbsp; · &nbsp; NO ACCOUNT REQUIRED</sub></p>

<p align="center">
  <a href="https://github.com/giran03/Suivelle/releases/latest"><strong>Download for Windows</strong></a>
  &nbsp; · &nbsp;
  <a href="https://suivelle.cafetako.com/demo/">Try the demo</a>
  &nbsp; · &nbsp;
  <a href="https://suivelle.cafetako.com/">Read the guide</a>
  &nbsp; · &nbsp;
  <a href="docs/changelog/0.1.5.md">What's new in 0.1.5</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme-workspace-dark-v014.png">
    <img src="docs/images/readme-workspace-light-v014.png" width="100%" alt="Suivelle workspace with a studio home page, weekly checklist, rich notes, and an organized page sidebar">
  </picture>
</p>

<p align="center"><sub>Screenshots show Suivelle's real interface with a fictional game studio, Hollow Orbit.</sub></p>

## What is Suivelle?

Suivelle is a Windows desktop app for notes, wikis, tasks and projects. It is built from a few simple parts: **pages** made of blocks, and **databases** whose records are pages too. Project trackers, calendars, dashboards and forms are all made from those same parts, so everything links to everything else.

Your workspace is stored on your computer. Suivelle works offline, needs no account, and can export everything you put into it.

## What you can do

**Write.** A block editor with headings, checklists, callouts, tables, code, equations, images, audio, video, PDFs and web embeds. Markdown shortcuts work as you type, and `/` opens every block.

**Connect.** Link pages with `@` or `[[wikilinks]]`, hover a link to preview it, and see every page that links back. Write `#tags`, find unlinked mentions, and explore it all on the **Node Map**, a 3D or 2D map of every page in every workspace.

**Organize.** Keep tasks and projects in databases with relations, rollups and formulas. Show the same records as a table, board, list, gallery, calendar, timeline, feed, chart, form or freeform **canvas**. Start from the Project Manager, Task Tracker or Software Project templates.

![A fictional game studio's Sprint Board with tasks grouped by status](docs/images/readme-project-board-v014.png)

**Plan.** Put a calendar on any page, make events with their own notes, repeat them, and drag unscheduled tasks into your day. A Master Calendar brings dates from several projects into one view.

![October studio calendar with focus sessions, reviews, and a multi-day playtest](docs/images/readme-calendar-v014.png)

**See progress.** Build dashboards of charts and summaries, collect entries with forms, and let local automations handle repeating steps.

**Work side by side.** Open pages in tabs or next to each other, jump anywhere with the command palette (<kbd>Ctrl</kbd> <kbd>K</kbd>), and open today's note with <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>D</kbd>.

![A development journal entry and Tether physics open beside each other in Suivelle's dark theme](docs/images/readme-side-peek-v014.png)

**Work with AI agents, if you want to.** Suivelle can be a shared knowledge base for Claude Code, Codex and other MCP apps on your computer. It never runs a model or starts an agent. Agents get their own token and permissions, their changes wait in a review inbox by default, and anything they change can be reverted. This is off until you turn it on in **Settings › Agents**.

**Make it yours.** Light, dark or system appearance; colors, fonts, page width, spacing and motion; rebindable keyboard and mouse shortcuts; and separate workspaces with their own names and icons.

## Guide

The full user guide lives at **[suivelle.cafetako.com](https://suivelle.cafetako.com/)**.

| Section | Pages |
| :--- | :--- |
| Start here | [Getting started](https://suivelle.cafetako.com/wiki/getting-started.html) |
| Write | [Pages and blocks](https://suivelle.cafetako.com/wiki/pages-and-blocks.html) · [Links, tags and backlinks](https://suivelle.cafetako.com/wiki/links-and-tags.html) |
| Organize | [Databases](https://suivelle.cafetako.com/wiki/databases.html) · [Database views](https://suivelle.cafetako.com/wiki/views.html) · [Canvases](https://suivelle.cafetako.com/wiki/canvases.html) · [Calendar and time](https://suivelle.cafetako.com/wiki/calendar.html) · [Dashboards and automation](https://suivelle.cafetako.com/wiki/dashboards-and-automation.html) |
| Explore | [Node Map](https://suivelle.cafetako.com/wiki/node-map.html) · [Search and navigation](https://suivelle.cafetako.com/wiki/navigation.html) |
| Extend | [Local AI agents](https://suivelle.cafetako.com/wiki/agents.html) |
| Make it yours | [Workspaces and appearance](https://suivelle.cafetako.com/wiki/workspaces-and-appearance.html) · [Keyboard shortcuts](https://suivelle.cafetako.com/wiki/shortcuts.html) |
| Keep it safe | [Data, backups and import](https://suivelle.cafetako.com/wiki/data-and-safety.html) |
| Releases | [What's new](https://suivelle.cafetako.com/wiki/whats-new.html) · [Full changelog](docs/changelog/) |

## Install

1. Download the `_x64-setup.exe` installer from the [latest release](https://github.com/giran03/Suivelle/releases/latest).
2. Run it. Suivelle installs for your user account and opens on a short *Getting started* checklist.
3. Installed copies check for updates, download them in the background, and wait for you to choose **Install and restart**. A verified backup of your data is made before every update.

Suivelle currently ships for Windows x64.

## Your data

- **Local:** your workspaces live in a SQLite database and an attachments folder on your computer. Editing works offline; embeds and update checks need a connection.
- **History and backups:** page history, automatic daily backups, and an optional second copy on another drive.
- **Import and export:** Markdown, text, HTML, CSV, folders of notes, supported Notion exports and Suivelle archives in; Markdown, HTML, PDF, CSV and whole-workspace archives out.
- **Recovery:** a safety copy is saved before database upgrades. If a check or upgrade fails, Suivelle opens the workspace read-only so you can export or restore it.

Keep independent backups of anything important. Local storage is only as safe as the computer it lives on.

## Build from source

You need Windows, [Node.js](https://nodejs.org/) 24, the stable [Rust](https://rustup.rs/) toolchain, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 and the MSVC build tools).

```bash
npm ci
npm run tauri dev
```

| Command | Does |
| :--- | :--- |
| `npm run tauri dev` | Run the desktop app with hot reload |
| `npm run build` | Type-check and build the frontend |
| `npm test` | Run the frontend tests |
| `npm run lint` | Lint with Biome |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib` | Run the Rust tests |
| `npm run showcase:build` | Build the website, guide and read-only demo |

More documentation:

- [`docs/`](docs/): feature notes ([agents](docs/agents.md), [calendar](docs/calendar.md), [shortcuts](docs/shortcuts.md), [Smart Paste](docs/smart-paste-and-actions.md), [Node Map](docs/node-map.md))
- [`showcase/README.md`](showcase/README.md): the website, guide and demo, and how to add a guide page
- [`docs/releasing.md`](docs/releasing.md): publishing signed releases

## About this project

Suivelle is a personal app built for everyday use and shared with others. Development, updates and support happen as time allows.

- Bugs and feature requests: [issue tracker](https://github.com/giran03/Suivelle/issues)
- Suspected vulnerabilities: [security policy](SECURITY.md)

## License

Suivelle is provided "as is," without warranties, under the [MIT License](LICENSE). Third-party dependencies and assets remain subject to their own licenses.

---

<p align="center"><strong>Your ideas. Your rhythm. Your workspace.</strong><br><sub>Suivelle</sub></p>
