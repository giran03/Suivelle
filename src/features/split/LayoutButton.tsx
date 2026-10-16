import { useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { anchorOf, Popover, type Anchor } from "../../components/Popover";
import { LayoutGlyph } from "./LayoutGlyph";
import { LAYOUTS } from "./layouts";
import { useSplit } from "./store";

/** The Topbar control for choosing a split layout. */
export function LayoutButton() {
  const layout = useSplit((s) => s.layout);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const active = layout !== "single";
  const count = useSplit((s) => s.panes.length + 1);
  const close = () => setAnchor(null);
  const choose = (id: (typeof LAYOUTS)[number]["id"]) => {
    if (id === "single") useSplit.getState().closeAll();
    else useSplit.getState().setLayout(id);
    close();
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`icon-btn${active ? " on" : ""}`}
        aria-label="Split view"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        title="Split view"
        onClick={() => setAnchor(anchor ? null : anchorOf(button.current!))}
      >
        <Icon name="columns" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close} label="Split view layout">
          <div className="split-menu" role="radiogroup" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" role="radio" aria-checked={layout === l.id} className="split-option" onClick={() => choose(l.id)}>
                <LayoutGlyph id={l.id} panes={l.id === "tiled" ? Math.max(3, count) : undefined} />
                <span className="split-option-text">
                  {l.label}
                  <small>{l.hint}</small>
                </span>
              </button>
            ))}
          </div>
          {active && (
            <>
              <hr />
              <button type="button" className="split-option" onClick={() => { useSplit.getState().evenOut(); close(); }}>Even out pane sizes</button>
            </>
          )}
          <p className="split-tiles"><small>Drag a page or tab to the edge of a pane to dock it there.</small></p>
        </Popover>
      )}
    </>
  );
}
