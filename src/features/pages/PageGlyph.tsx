import { useState } from "react";
import { Icon } from "../../components/Icon";
import { attachmentUrl, thumbUrl } from "../../lib/attachments";
import type { Page } from "../../types";
import { parseIcon } from "./pageAppearance";

const kindIcon = (kind: Page["kind"]) => (kind === "database" ? "table" : kind === "dashboard" ? "dashboard" : "page");

/** A page's chosen emoji, line icon or local image, or the default for its kind. */
export function PageGlyph({ page, size = 16 }: { page: Pick<Page, "icon" | "kind">; size?: number }) {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const glyph = parseIcon(page.icon);
  if (glyph?.kind === "image" && failedImage !== glyph.hash) {
    return <img className="pg-image" src={thumbUrl(glyph.hash, 320)} alt="" aria-hidden="true" draggable={false}
      width={size} height={size} onError={(e) => {
        const full = attachmentUrl(glyph.hash);
        if (e.currentTarget.src !== full) e.currentTarget.src = full;
        else setFailedImage(glyph.hash);
      }} />;
  }
  if (glyph?.kind === "emoji") {
    return (
      <span className="pg-emoji" style={{ width: size, height: size, fontSize: size * 0.88 }} aria-hidden="true">
        <span>{glyph.value}</span>
      </span>
    );
  }
  return <Icon name={glyph?.kind === "icon" ? glyph.name : kindIcon(page.kind)} size={size} />;
}
