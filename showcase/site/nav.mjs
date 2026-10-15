// The wiki's table of contents. The layout plugin builds the sidebar, prev/next links and the
// search index from it, and the home page atlas draws one star per page, joined by `links`.
export const SECTIONS = [
  {
    title: "Start here",
    pages: [
      { slug: "getting-started", title: "Getting started", blurb: "Install Suivelle, open your first workspace and learn the five keys that matter.", links: ["pages-and-blocks", "navigation", "data-and-safety"] },
    ],
  },
  {
    title: "Write",
    pages: [
      { slug: "pages-and-blocks", title: "Pages and blocks", blurb: "The block editor: slash menu, markdown shortcuts, media, equations, synced blocks and Smart Paste.", links: ["links-and-tags", "databases"] },
      { slug: "links-and-tags", title: "Links, tags and backlinks", blurb: "Mentions, [[wikilinks]], hover previews, backlinks, unlinked mentions, #tags and the outline.", links: ["node-map", "navigation"] },
    ],
  },
  {
    title: "Organize",
    pages: [
      { slug: "databases", title: "Databases", blurb: "Eighteen property types, relations, rollups, formulas, record templates and project starters.", links: ["views", "dashboards-and-automation"] },
      { slug: "views", title: "Database views", blurb: "Table, board, list, gallery, calendar, timeline, feed, chart, form and canvas over the same records.", links: ["canvases", "calendar"] },
      { slug: "canvases", title: "Canvases", blurb: "Freeform boards for records, notes, images, arrows and full editable pages.", links: ["views", "node-map"] },
      { slug: "calendar", title: "Calendar and time", blurb: "Calendar blocks, events as pages, recurrence, a Master Calendar and drag-to-schedule time blocking.", links: ["databases", "navigation"] },
      { slug: "dashboards-and-automation", title: "Dashboards and automation", blurb: "Charts, live dashboards, forms and local automations with triggers, conditions and actions.", links: ["databases"] },
    ],
  },
  {
    title: "Explore",
    pages: [
      { slug: "node-map", title: "Node Map", blurb: "Every page of every workspace in 3D or 2D: focus, dive, search, connect and undo.", links: ["links-and-tags", "agents"] },
      { slug: "navigation", title: "Search and navigation", blurb: "Command palette, saved searches, tabs, side-by-side panes, daily notes, quick capture and reminders.", links: ["shortcuts"] },
    ],
  },
  {
    title: "Extend",
    pages: [
      { slug: "agents", title: "Local AI agents", blurb: "Let Claude Code, Codex and other MCP clients use your workspace, with every change reviewable.", links: ["data-and-safety", "links-and-tags"] },
    ],
  },
  {
    title: "Make it yours",
    pages: [
      { slug: "workspaces-and-appearance", title: "Workspaces and appearance", blurb: "Separate workspaces, themes, colors, typography, spacing, corners and motion levels.", links: ["shortcuts"] },
      { slug: "shortcuts", title: "Keyboard shortcuts", blurb: "Every default binding, and how to rebind keys and mouse buttons per device.", links: ["navigation"] },
    ],
  },
  {
    title: "Keep it safe",
    pages: [
      { slug: "data-and-safety", title: "Data, backups and import", blurb: "Local-first storage, page history, verified backups, import and export, storage health and recovery.", links: ["workspaces-and-appearance"] },
    ],
  },
  {
    title: "Releases",
    pages: [
      { slug: "whats-new", title: "What's new", blurb: "Highlights of 0.1.5 and 0.1.4.", links: ["agents", "node-map", "canvases"] },
    ],
  },
];

export const PAGES = SECTIONS.flatMap(section => section.pages.map(page => ({ ...page, section: section.title })));
