import { autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import { useEffect, useRef } from "react";
import { thumbUrl } from "../../lib/attachments";
import { useWorkspace } from "../../stores/workspace";
import { PageGlyph } from "../pages/PageGlyph";
import { usePeek } from "../peek/store";
import { hidePreview, usePreviewCard } from "./store";
import "./preview.css";

/** The floating card for a hovered page link. It never takes focus, so typing in the editor goes on. */
export function PagePreviewCard() {
  const { pageId, anchor, data } = usePreviewCard();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const card = ref.current;
    if (!card || !anchor) return;
    const virtual = { getBoundingClientRect: () => anchor };
    return autoUpdate(virtual, card, () => {
      void computePosition(virtual, card, { placement: "bottom-start", middleware: [offset(6), flip(), shift({ padding: 8 })] }).then(({ x, y }) => {
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        card.style.visibility = "visible";
      });
    });
  }, [anchor]);

  if (!pageId || !anchor) return null;
  const open = (beside: boolean) => {
    hidePreview();
    if (beside) usePeek.getState().show(pageId);
    else void useWorkspace.getState().openPage(pageId);
  };

  return (
    <div ref={ref} className="page-preview" data-page-preview role="tooltip" style={{ visibility: "hidden" }}>
      {data === undefined ? (
        <p className="pp-muted">Loading…</p>
      ) : data === null || data.deleted ? (
        <p className="pp-muted">{data?.deleted ? "This page is in the trash" : "This page no longer exists"}</p>
      ) : (
        <>
          <div className="pp-title">
            <PageGlyph page={{ icon: data.icon, kind: "page" }} />
            <span>{data.title || "Untitled"}</span>
          </div>
          {data.imageHash && <img className="pp-image" src={thumbUrl(data.imageHash, 320)} alt="" loading="lazy" />}
          {data.lines.length > 0 ? (
            <div className="pp-body">
              {data.lines.map((l, i) => (
                <p key={i} className={l.kind.startsWith("heading") ? "pp-heading" : undefined}>
                  {l.text}
                </p>
              ))}
            </div>
          ) : (
            !data.imageHash && <p className="pp-muted">Empty page</p>
          )}
          <div className="pp-actions">
            <button type="button" onClick={() => open(false)}>Open</button>
            <button type="button" onClick={() => open(true)}>Open beside</button>
          </div>
        </>
      )}
    </div>
  );
}
