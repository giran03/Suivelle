import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { copyText } from "../../../components/editingMenu";
import { ipc, toAppError } from "../../../lib/ipc";
import { EMBED_DEFAULTS, embedData, embedTarget, type EmbedTarget } from "../embedModel";
import { pickAttachment } from "./media";
import "../embed.css";

function EmbedView({ node, editor, updateAttributes, getPos, selected }: NodeViewProps) {
  const data = embedData(node.attrs);
  const [editing, setEditing] = useState(!data.url);
  const [draft, setDraft] = useState(data);
  const [preview, setPreview] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [slow, setSlow] = useState(false);
  const [resizeHeight, setResizeHeight] = useState<number | null>(null);
  const size = useRef<{ y: number; height: number } | null>(null);
  const frameBox = useRef<HTMLDivElement>(null);
  const editable = editor.isEditable;
  let target: EmbedTarget | null = null, candidate: EmbedTarget | null = null, candidateError = "";
  try { if (data.url) target = embedTarget(data.url); } catch { /* Imported bad URLs stay inert. */ }
  try { if (draft.url.trim()) candidate = embedTarget(draft.url); } catch (e) { candidateError = (e as Error).message; }
  useEffect(() => { setLoaded(false); setInteractive(false); setSlow(false); }, [data.url, data.mode]);
  useEffect(() => { if (!data.url) { setDraft(embedData(node.attrs)); setEditing(true); } }, [data.url]);
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener("online", change); window.addEventListener("offline", change);
    return () => { window.removeEventListener("online", change); window.removeEventListener("offline", change); };
  }, []);
  useEffect(() => {
    if (!loaded || !online) return;
    const timer = window.setTimeout(() => setSlow(true), 10000);
    return () => window.clearTimeout(timer);
  }, [loaded, online, reload]);
  const run = async (fn: () => Promise<unknown>) => { try { setError(null); await fn(); } catch (e) { setError(toAppError(e).message); } };
  const save = () => {
    if (!candidate) return;
    updateAttributes({ ...draft, url: candidate.source, mode: candidate.frame ? draft.mode : "link" });
    setEditing(false); setPreview(false); setError(null);
  };
  const frame = (value: EmbedTarget, title: string) => <iframe key={`${value.frame}:${reload}`} src={value.frame!} title={title || `${value.provider} embed`} loading="lazy"
    sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" allow="fullscreen; encrypted-media; picture-in-picture" allowFullScreen
    referrerPolicy="strict-origin-when-cross-origin" onError={() => setError("This content could not load. Try reloading or open it in your browser.")} />;
  const changeSize = (height: number) => Math.max(160, Math.min(1200, Math.round(height)));
  return <NodeViewWrapper className={`web-embed${selected ? " is-selected" : ""}`} contentEditable={false} data-align={data.align} style={{ width: `${data.width}%` }}>
    {editing && editable ? <form className="embed-editor" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); save(); }}>
      <strong>{data.url ? "Edit embed" : "Embed a link"}</strong>
      <p>YouTube videos and playlists, or Google Maps embed links. Other links become link cards.</p>
      <label>Link or iframe code<textarea autoFocus rows={2} maxLength={8192} value={draft.url} placeholder="Paste an HTTPS link or embed code…" onChange={(e) => { setDraft({ ...draft, url: e.target.value }); setPreview(false); }} /></label>
      {candidateError && <p className="field-error" role="alert">{candidateError}</p>}
      <label><span>Title <small>Optional</small></span><input maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></label>
      <label><span>Caption <small>Optional</small></span><input maxLength={2000} value={draft.caption} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} /></label>
      {candidate && <div className="embed-preview"><span>{candidate.provider}{candidate.frame ? " · Interactive embed" : " · Link card"}</span>
        {preview && candidate.frame && online ? <div className="embed-frame" style={{ aspectRatio: "16 / 9" }}>{frame(candidate, draft.title)}</div> : candidate.frame && <button type="button" className="btn" disabled={!online} onClick={() => setPreview(true)}>Load preview</button>}
      </div>}
      <div className="embed-actions"><button type="submit" className="btn primary" disabled={!candidate}>{data.url ? "Save" : "Insert"}</button>
        <button type="button" className="btn" onClick={() => { if (!data.url) { const pos = getPos(); if (typeof pos === "number") editor.commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: "paragraph", attrs: { blockId: node.attrs.blockId } }); } else setEditing(false); setPreview(false); }}>Cancel</button>
        {!data.url && <button type="button" className="btn" onClick={() => void run(async () => { const attrs = await pickAttachment("pdf"); const pos = getPos(); if (attrs && typeof pos === "number") editor.commands.insertContentAt({ from: pos, to: pos + node.nodeSize }, { type: "pdf", attrs: { ...attrs, blockId: node.attrs.blockId } }); })}>Upload a PDF…</button>}
      </div>
    </form> : <>
      <div className="embed-head"><Icon name={target?.provider === "YouTube" ? "play" : "open"} size={16} /><strong>{data.title || target?.provider || "Embed"}</strong>
        {target && <button type="button" className="icon-btn" aria-label="Open embed in browser" title="Open in browser" onClick={() => void run(() => ipc.imageOpenLink(target.source))}><Icon name="open" size={16} /></button>}
        {editable && <details className="embed-menu"><summary aria-label="Embed options" title="Embed options"><Icon name="more" size={16} /></summary><div>
          <button type="button" className="btn" onClick={() => { setDraft(data); setEditing(true); }}>Edit link and caption</button>
          {target && <button type="button" className="btn" onClick={() => void run(() => copyText(target.source))}>Copy link</button>}
          {target?.frame && <button type="button" className="btn" onClick={() => updateAttributes({ mode: data.mode === "link" ? "embed" : "link" })}>{data.mode === "link" ? "Show embed" : "Convert to link card"}</button>}
          <label>Width<select value={data.width} onChange={(e) => updateAttributes({ width: Number(e.target.value) })}>{[25, 50, 75, 100].map((w) => <option key={w} value={w}>{w}%</option>)}</select></label>
          <label>Alignment<select value={data.align} onChange={(e) => updateAttributes({ align: e.target.value })}>{["left", "center", "right"].map((align) => <option key={align} value={align}>{align}</option>)}</select></label>
          <label>Shape<select value="" onChange={(e) => { const width = frameBox.current?.clientWidth ?? 640; updateAttributes({ height: e.target.value === "auto" ? null : changeSize(width / Number(e.target.value)) }); }}><option value="" disabled>Choose a size…</option><option value="auto">Automatic</option><option value="1.77777778">Video (16:9)</option><option value="1">Square</option><option value="0.75">Document (3:4)</option></select></label>
        </div></details>}
      </div>
      {target?.frame && data.mode !== "link" ? <>
        <div ref={frameBox} className="embed-frame" style={{ height: resizeHeight ?? data.height ?? (target.provider === "Google Maps" ? 360 : undefined), aspectRatio: data.height === null && resizeHeight === null && target.provider === "YouTube" ? "16 / 9" : undefined }}>
          {loaded && online && frame(target, data.title)}
          {!loaded || !online ? <div className="embed-placeholder"><Icon name={target.provider === "YouTube" ? "play" : "open"} size={28} /><p>{online ? `Load ${target.provider} content when you need it.` : "You’re offline. The link and caption are saved."}</p><button type="button" className="btn" disabled={!online} onClick={() => { setLoaded(true); setSlow(false); }}>Load {target.provider}</button></div>
            : !interactive && <button type="button" className="embed-interact" onClick={() => setInteractive(true)}><span>Click to interact</span></button>}
          {editable && <button type="button" className="embed-resize" aria-label="Resize embed height. Use Up and Down arrow keys." title="Drag to resize height" onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); size.current = { y: e.clientY, height: frameBox.current?.clientHeight ?? 360 }; e.currentTarget.setPointerCapture(e.pointerId); setInteractive(false); }} onPointerMove={(e) => { if (size.current && e.currentTarget.hasPointerCapture(e.pointerId)) setResizeHeight(changeSize(size.current.height + e.clientY - size.current.y)); }} onPointerUp={(e) => { if (!size.current) return; updateAttributes({ height: changeSize(size.current.height + e.clientY - size.current.y) }); size.current = null; setResizeHeight(null); }} onLostPointerCapture={() => { size.current = null; setResizeHeight(null); }} onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); updateAttributes({ height: changeSize((data.height ?? frameBox.current?.clientHeight ?? 360) + (e.key === "ArrowUp" ? -20 : 20)) }); } }}><Icon name="grip" size={14} /></button>}
        </div>
        {loaded && online && <div className="embed-actions"><button type="button" className="link" onClick={() => { setReload((n) => n + 1); setSlow(false); setError(null); }}>Reload</button><button type="button" className="link" onClick={() => setInteractive(false)}>Return to page scrolling</button>{slow && <small>Blank or unavailable? Open the link in your browser.</small>}</div>}
      </> : <div className="embed-link-card">{target ? <><span>{target.source}</span><button type="button" className="btn" onClick={() => void run(() => ipc.imageOpenLink(target.source))}>Open in browser</button></> : <p>{data.url ? "This saved link is invalid. Edit it to choose a new link." : "Add a YouTube, Google Maps, or website link."}</p>}</div>}
      {data.caption && <p className="embed-caption">{data.caption}</p>}
    </>}
    {error && <p className="field-error" role="alert">{error}</p>}
  </NodeViewWrapper>;
}

export const EmbedBlock = Node.create({
  name: "embed", group: "block", atom: true, draggable: true, selectable: true,
  addAttributes() { return Object.fromEntries(Object.entries(EMBED_DEFAULTS).map(([key, value]) => [key, { default: value, renderHTML: () => ({}), parseHTML: (element: HTMLElement) => {
    try { return embedData(JSON.parse(element.getAttribute("data-suivelle-embed") ?? "{}"))[key as keyof typeof EMBED_DEFAULTS]; } catch { return value; }
  } }])); },
  parseHTML() { return [{ tag: 'div[data-type="web-embed"]' }, { tag: 'figure[data-suivelle-embed]' }]; },
  renderHTML({ node, HTMLAttributes }) { return ["div", mergeAttributes({ "data-type": "web-embed", "data-suivelle-embed": JSON.stringify(embedData(node.attrs)) }, HTMLAttributes)]; },
  addNodeView() { return ReactNodeViewRenderer(EmbedView, { stopEvent: () => true, ignoreMutation: () => true }); },
});
