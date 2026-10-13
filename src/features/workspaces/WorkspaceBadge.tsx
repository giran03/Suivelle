import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import { BrandMark } from "../../components/BrandMark";
import type { Workspace } from "../../types";
import { workspaceColor, workspaceOptions, WORKSPACE_SYMBOLS } from "./model";
import { PageGlyph } from "../pages/PageGlyph";
import "./workspaces.css";
export function WorkspaceBadge({ workspace, imageSrc }: { imageSrc?: string; workspace: Pick<Workspace, "icon" | "settingsJson"> | null }) {
  const icon = workspace?.icon;
  const symbol = icon?.startsWith("symbol:") ? icon.slice(7) : null;
  return <span className="ws-badge" style={{ "--workspace-color": workspaceColor(workspaceOptions(workspace).accent) } as CSSProperties} aria-hidden="true">
    {imageSrc ? <img className="pg-image" src={imageSrc} alt="" draggable={false} /> : icon?.startsWith("image:") ? <PageGlyph page={{ icon, kind: "page" }} size={32} /> : symbol && WORKSPACE_SYMBOLS.includes(symbol as typeof WORKSPACE_SYMBOLS[number]) ? <Icon name={symbol as typeof WORKSPACE_SYMBOLS[number]} size={18} /> : icon ? <span className="ws-custom-icon">{icon}</span> : <BrandMark size={20} tile={false} />}
  </span>;
}
