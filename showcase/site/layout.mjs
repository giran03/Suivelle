import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, SECTIONS } from "./nav.mjs";

// Wiki pages are written as a bare <article>. This plugin wraps each one in the shared shell
// (top bar, sidebar, table of contents, prev/next), gives headings stable ids, and emits a small
// search index, so the pages stay pure content and the site has no client-side router.

export const REPO = "https://github.com/giran03/Suivelle";
export const RELEASES = `${REPO}/releases`;

// Download buttons point straight at the installer of the latest published release, looked up
// once per build through the GitHub API (GITHUB_TOKEN is used when set, as in CI); the page
// checks again when it loads (site.js), so a release published after the build is picked up
// too. Releases still in draft are invisible to the public, so without a published one the
// buttons open the releases page instead of a link that would 404.
const download = { href: RELEASES, meta: "Windows x64" };
let resolving = null;
function resolveDownload() {
  resolving ??= (async () => {
    try {
      const headers = { Accept: "application/vnd.github+json", "User-Agent": "suivelle-site-build" };
      if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      const res = await fetch("https://api.github.com/repos/giran03/Suivelle/releases/latest", { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const release = await res.json();
      const asset = release.assets?.find(a => /_x64-setup\.exe$/i.test(a.name));
      if (!asset) throw new Error(`no x64 installer in ${release.tag_name}`);
      const mb = (asset.size / 1048576).toFixed(1);
      download.href = asset.browser_download_url;
      download.meta = `Version ${release.tag_name.replace(/^v/, "")} · ${mb} MB · Windows x64`;
      console.log(`[site] Download links: ${asset.name}`);
    } catch (e) {
      console.warn(`[site] No published release found (${e.message}); download links open ${RELEASES}`);
    }
  })();
  return resolving;
}

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.resolve(siteDir, "../../docs/images");

export const slugify = text => text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const strip = html => html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

const ICONS = {
  search: '<path d="M10.5 18a7.5 7.5 0 1 1 5.3-2.2L21 21" />',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  play: '<path d="M7 5v14l11-7Z"/>',
  github: '<path d="M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
};
export const icon = (name, cls = "icon") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

export const MARK = `<svg class="mark" viewBox="0 0 96 96" aria-hidden="true"><rect class="mark-tile" x="1" y="1" width="94" height="94" rx="22"/><g transform="translate(48 48) scale(1.08) translate(-55 -47)"><path class="mark-s" d="M66 28H48A12 12 0 0 0 48 52A12 12 0 0 1 48 76H30" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path class="mark-k" d="M70 13C71.6 23.5 74.5 26.4 85 28C74.5 29.6 71.6 32.5 70 43C68.4 32.5 65.5 29.6 55 28C65.5 26.4 68.4 23.5 70 13Z"/></g></svg>`;

function idHeadings(article) {
  const seen = new Set();
  return article.replace(/<h([23])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (all, level, attrs = "", inner) => {
    if (/\sid=/.test(attrs)) return all;
    let id = slugify(inner) || "section";
    while (seen.has(id)) id += "-2";
    seen.add(id);
    return `<h${level} id="${id}"${attrs}>${inner}</h${level}>`;
  });
}

function sidebar(root, slug) {
  return SECTIONS.map(section => `
      <div class="nav-group">
        <p class="nav-label">${section.title}</p>
        <ul>${section.pages.map(p => `<li><a href="${root}wiki/${p.slug}.html"${p.slug === slug ? ' aria-current="page"' : ""}>${p.title}</a></li>`).join("")}</ul>
      </div>`).join("");
}

function topbar(root, home) {
  return `
  <a class="skip" href="#main">Skip to content</a>
  <header class="topbar" data-home="${home}">
    <div class="topbar-inner">
      ${home ? "" : `<button class="icon-btn menu-btn" type="button" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">${icon("menu")}</button>`}
      <a class="brand" href="${root}index.html">${MARK}<span>Suivelle</span></a>
      <nav class="topnav" aria-label="Site">
        <a href="${root}wiki/getting-started.html">Wiki</a>
        <a href="${root}wiki/whats-new.html">What's new</a>
        <a href="${REPO}">GitHub</a>
      </nav>
      <div class="top-actions">
        <button class="search-trigger" type="button" data-search-open aria-label="Search the wiki">${icon("search")}<span>Search</span><kbd>Ctrl K</kbd></button>
        <button class="icon-btn theme-btn" type="button" aria-label="Switch theme" title="Switch theme">${icon("sun", "icon icon-sun")}${icon("moon", "icon icon-moon")}</button>
        <a class="btn btn-secondary demo-link" href="${root}demo/">${icon("play")}<span>Live demo</span></a>
        <a class="btn btn-primary" href="${download.href}" title="${download.meta}">${icon("download")}<span>Download</span></a>
      </div>
    </div>
  </header>`;
}

function footer(root) {
  return `
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">${MARK}<div><b>Suivelle</b><p>A universe for your thoughts.</p></div></div>
      <nav aria-label="Footer">
        <a href="${root}wiki/getting-started.html">Getting started</a>
        <a href="${root}demo/">Live demo</a>
        <a href="${download.href}">Download for Windows</a>
        <a href="${RELEASES}">All releases</a>
        <a href="${REPO}/issues">Report an issue</a>
        <a href="${REPO}/blob/main/LICENSE">MIT License</a>
      </nav>
      <p class="footer-note">A personal project, shared as is. Screens and sample data on this site are fictional mock-ups made with Suivelle's real interface.</p>
    </div>
  </footer>
  <dialog class="search-dialog" aria-label="Search the wiki">
    <div class="search-box">
      <div class="search-field">${icon("search")}<input type="search" placeholder="Search features, shortcuts, settings…" aria-label="Search" autocomplete="off" spellcheck="false" /><kbd>Esc</kbd></div>
      <ul class="search-results" role="listbox" aria-label="Results"></ul>
      <p class="search-empty" hidden>No pages match. Try a feature name such as “calendar” or “backup”.</p>
    </div>
  </dialog>`;
}

function pager(root, slug) {
  const i = PAGES.findIndex(p => p.slug === slug);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  const link = (p, dir) => p ? `<a class="pager-${dir}" href="${root}wiki/${p.slug}.html"><span>${dir === "prev" ? icon("arrowLeft") + "Previous" : "Next" + icon("arrowRight")}</span><b>${p.title}</b></a>` : "<span></span>";
  return `<nav class="pager" aria-label="Previous and next">${link(prev, "prev")}${link(next, "next")}</nav>`;
}

function head(root, title, description, home) {
  return `
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${home ? "Suivelle: a calm, local-first workspace" : `${title} · Suivelle wiki`}</title>
    <meta name="description" content="${description}" />
    <meta property="og:title" content="${home ? "Suivelle" : `${title} · Suivelle`}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="website" />
    <meta property="og:image" content="${root}og.png" />
    <meta name="theme-color" content="#0c1329" media="(prefers-color-scheme: dark)" />
    <meta name="theme-color" content="#f7f6f2" media="(prefers-color-scheme: light)" />
    <link rel="icon" type="image/svg+xml" href="${root}favicon.svg" />
    <script>try{const t=localStorage.getItem("suivelle-site-theme");if(t)document.documentElement.dataset.theme=t}catch{}</script>
    <script type="module" src="/src/site.js"></script>`;
}

let serving = false;

export function render(html, file) {
  const rel = path.relative(siteDir, file).replace(/\\/g, "/");
  const depth = rel.split("/").length - 1;
  const root = depth ? "../".repeat(depth) : "./";
  const home = rel === "index.html";
  const slug = home ? "home" : path.basename(rel, ".html");
  const page = PAGES.find(p => p.slug === slug);
  const title = page?.title ?? "Suivelle";
  const description = page?.blurb ?? "A calm desktop workspace for notes, projects and the plans between them. Local first, offline ready, no account required.";
  const article = (html.match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? html)
    .replaceAll("@img/", serving ? `/@fs/${imagesDir.replace(/\\/g, "/")}/` : path.relative(path.dirname(file), imagesDir).replace(/\\/g, "/") + "/")
    .replaceAll("@root/", root)
    .replaceAll('title="@download-meta"', `title="${download.meta}"`)
    .replaceAll("@download-meta", `<span data-download-meta>${download.meta}</span>`)
    .replaceAll("@download", download.href)
    .replaceAll("@releases", RELEASES)
    .replace("<!--atlas-links-->", PAGES.map(p => `<a href="${root}wiki/${p.slug}.html">${p.title}</a>`).join(" · "))
    .replace(/<div class="index" data-feature-index><\/div>/, `<div class="index">${SECTIONS.map(s => `
      <div class="index-row reveal"><p>${s.title}</p><ul>${s.pages.map(p => `<li><a href="${root}wiki/${p.slug}.html"><b>${p.title}</b><span>${p.blurb}</span>${icon("arrowRight")}</a></li>`).join("")}</ul></div>`).join("")}
    </div>`);
  const body = home
    ? `${topbar(root, true)}<main id="main" class="home">${article}</main>${footer(root)}`
    : `${topbar(root, false)}
  <div class="wiki-shell">
    <aside class="sidebar" id="sidebar" aria-label="Wiki pages">
      <nav>${sidebar(root, slug)}</nav>
      <a class="sidebar-demo" href="${root}demo/">${icon("play")}<span><b>Try the live demo</b>A read-only copy of the real app with sample data</span></a>
    </aside>
    <div class="sidebar-scrim" hidden></div>
    <main id="main" class="doc-main">
      <article class="doc" data-slug="${slug}">
        <p class="doc-crumb"><a href="${root}wiki/getting-started.html">Wiki</a><span aria-hidden="true">/</span>${page?.section ?? ""}</p>
        ${idHeadings(article)}
      </article>
      ${pager(root, slug)}
    </main>
    <aside class="toc" aria-label="On this page"><p class="nav-label">On this page</p><ul></ul><div class="toc-progress" aria-hidden="true"><span></span></div></aside>
  </div>
  ${footer(root)}`;
  return `<!doctype html>
<html lang="en" data-root="${root}" data-download="${download.href}">
  <head>${head(root, title, description, home)}
  </head>
  <body class="${home ? "is-home" : "is-wiki"}">
${body}
  </body>
</html>`;
}

function searchIndex() {
  const entries = [];
  for (const p of PAGES) {
    const file = path.join(siteDir, "wiki", `${p.slug}.html`);
    if (!fs.existsSync(file)) continue;
    const article = idHeadings((fs.readFileSync(file, "utf8").match(/<body[^>]*>([\s\S]*)<\/body>/)?.[1] ?? "").replaceAll("@download-meta", download.meta));
    const parts = article.split(/(?=<h2 id=")/);
    entries.push({ url: `wiki/${p.slug}.html`, page: p.title, heading: p.title, text: `${p.blurb} ${strip(parts[0]).slice(0, 300)}` });
    for (const part of parts.slice(1)) {
      const m = part.match(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/);
      if (m) entries.push({ url: `wiki/${p.slug}.html#${m[1]}`, page: p.title, heading: strip(m[2]), text: strip(part.slice(m[0].length)).slice(0, 600) });
    }
  }
  return JSON.stringify(entries);
}

export function wikiLayout() {
  return {
    name: "suivelle-wiki-layout",
    configResolved(config) { serving = config.command === "serve"; },
    async buildStart() { await resolveDownload(); },
    transformIndexHtml: { order: "pre", handler: async (html, ctx) => { await resolveDownload(); return render(html, ctx.filename); } },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.endsWith("/search-index.json")) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(searchIndex());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "search-index.json", source: searchIndex() });
    },
  };
}
