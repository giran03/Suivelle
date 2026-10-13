import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "./Icon";
import { syncDialog } from "../lib/dialog";
import { hexToHsv, hexToRgb, hsvToHex, normalizeHex, normalizeHexAlpha, hexOpacity, withOpacity, recentColors, rgbToHex } from "../lib/color";
import "./color-picker.css";

const PRESETS = ["#7C3AED", "#64748B", "#2563EB", "#16A34A", "#EA580C", "#DC2626", "#EC4899", "#14B8A6"];

/** A themed, local draft: only Use color updates its caller. */
export function ColorPicker({ initial, preview, onUse, onClose, allowOpacity = false, title = "Custom icon color", hint = "Preview · color applies to symbols" }: {
  title?: string; hint?: string; allowOpacity?: boolean;
  initial: string; preview?: (color: `#${string}`) => ReactNode;
  onUse: (color: `#${string}`) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const normalize = allowOpacity ? normalizeHexAlpha : normalizeHex;
  const [hsv, setHsv] = useState(() => hexToHsv(normalize(initial) ?? "#7C3AED"));
  const [opacity, setOpacity] = useState(() => allowOpacity ? hexOpacity(normalize(initial) ?? "#7C3AED") : 1);
  const [opacityText, setOpacityText] = useState(() => String(Math.round(opacity * 100)));
  const color = withOpacity(hsvToHex(...hsv), opacity);
  const [hexText, setHexText] = useState<string>(color);
  const [rgbText, setRgbText] = useState(() => hexToRgb(color).map(String));
  const [recents, setRecents] = useState(recentColors);
  useEffect(() => {
    const element = dialog.current;
    if (element) syncDialog(element, true);
    const sync = () => setRecents(recentColors());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const validHex = normalize(hexText);
  const validRgb = rgbText.every((v) => /^\d{1,3}$/.test(v) && Number(v) <= 255);
  const validOpacity = !allowOpacity || /^\d{1,3}$/.test(opacityText) && Number(opacityText) <= 100;
  const valid = validHex !== null && validRgb && validOpacity;
  const update = (next: [number, number, number]) => {
    setHsv(next); const hex = withOpacity(hsvToHex(...next), opacity); setHexText(hex); setRgbText(hexToRgb(hex).map(String));
  };
  const choose = (hex: string) => { setHsv(hexToHsv(hex)); setOpacity(hexOpacity(hex)); setOpacityText(String(Math.round(hexOpacity(hex) * 100))); setHexText(hex); setRgbText(hexToRgb(hex).map(String)); };
  const changeOpacity = (percent: number) => { const alpha = percent / 100; setOpacity(alpha); setOpacityText(String(percent)); setHexText(withOpacity(hsvToHex(...hsv), alpha)); };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
    update([hsv[0], s, v]);
  };
  const swatch = (hex: string) => <button type="button" key={hex} className="color-swatch" aria-label={`Use ${hex}`} aria-pressed={color === hex}
    style={{ background: hex, color: hexToRgb(hex).reduce((sum, n, i) => sum + n * [0.299, 0.587, 0.114][i], 0) > 150 ? "#111827" : "#FFFFFF" }}
    onClick={() => choose(hex)}>{color === hex && <Icon name="check" size={14} />}</button>;
  return <dialog ref={dialog} className="palette color-picker" aria-labelledby="color-picker-title"
    onCancel={(e) => { e.preventDefault(); onClose(); }}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); onClose(); } else if (e.key === "Enter" && e.target instanceof HTMLInputElement) { e.preventDefault(); if (valid) { onUse(color); onClose(); } } }}>
    <header><h2 id="color-picker-title">{title}</h2><button type="button" className="icon-btn" aria-label="Close color picker" onClick={onClose}><Icon name="close" /></button></header>
    <div className="color-picker-body">
      <div className="color-preview">{preview?.(color) ?? (allowOpacity && <span className="color-alpha-preview" aria-hidden="true"><i style={{ background: color }} /></span>)}<span><strong>{color}</strong><small className="picker-muted">{hint}</small></span></div>
      <div className="color-plane" aria-hidden="true" style={{ "--picker-hue": `hsl(${hsv[0]} 100% 50%)` } as CSSProperties}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); move(e); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e); }}
        onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}>
        <span className="color-plane-thumb" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: color }} />
      </div>
      <label className="color-slider"><span>Hue</span><input className="color-hue" type="range" min={0} max={359} value={hsv[0]} onChange={(e) => update([Number(e.target.value), hsv[1], hsv[2]])} /></label>
      <div className="color-sv-sliders">{(["Saturation", "Brightness"] as const).map((name, i) => <label className="color-slider" key={name}><span>{name}</span><input type="range" min={0} max={100} value={Math.round(hsv[i + 1] * 100)} onChange={(e) => { const next: [number, number, number] = [...hsv]; next[i + 1] = Number(e.target.value) / 100; update(next); }} /></label>)}</div>
      {allowOpacity && <div className="color-opacity"><label className="color-slider"><span>Opacity</span><input type="range" min={0} max={100} value={Math.round(opacity * 100)} aria-valuetext={`${Math.round(opacity * 100)} percent`} onChange={e => changeOpacity(Number(e.target.value))} /></label><label className="color-opacity-value"><input aria-label="Opacity percentage" aria-invalid={!validOpacity} type="number" min={0} max={100} step={1} value={opacityText} onChange={e => { const text = e.target.value; setOpacityText(text); if (/^\d{1,3}$/.test(text) && Number(text) <= 100) changeOpacity(Number(text)); }} /><span>%</span></label></div>}
      <div className="color-values"><label><span>Hex</span><input autoFocus aria-invalid={!validHex} maxLength={allowOpacity ? 9 : 7} value={hexText} spellCheck={false} onChange={(e) => { const text = e.target.value; setHexText(text); const hex = normalize(text); if (hex) { setHsv(hexToHsv(hex)); setOpacity(hexOpacity(hex)); setOpacityText(String(Math.round(hexOpacity(hex) * 100))); setRgbText(hexToRgb(hex).map(String)); } }} onBlur={() => { if (validHex) setHexText(validHex); }} /></label>
        {(["R", "G", "B"] as const).map((name, i) => <label key={name}><span>{name}</span><input inputMode="numeric" maxLength={3} aria-label={`${name} channel`} aria-invalid={!/^\d{1,3}$/.test(rgbText[i]) || Number(rgbText[i]) > 255} value={rgbText[i]} onChange={(e) => { const next = [...rgbText]; next[i] = e.target.value; setRgbText(next); if (next.every((v) => /^\d{1,3}$/.test(v) && Number(v) <= 255)) { const hex = rgbToHex(next.map(Number)); setHsv(hexToHsv(hex)); setHexText(withOpacity(hex, opacity)); } }} /></label>)}
      </div>
      {!valid && <p className="field-error" role="status">{!validOpacity ? "Enter an opacity from 0 to 100%." : <>Enter {allowOpacity ? "#RGB, #RGBA, #RRGGBB or #RRGGBBAA" : "#RGB or #RRGGBB"} and RGB values from 0 to 255.</>}</p>}
      <div className="color-swatches"><span>Presets</span><div role="group" aria-label="Color presets">{PRESETS.map(swatch)}</div></div>
      <div className="color-swatches"><span>Recent colors</span>{recents.filter(hex => allowOpacity || normalizeHex(hex)).length ? <div role="group" aria-label="Recent colors">{recents.filter(hex => allowOpacity || normalizeHex(hex)).map(swatch)}</div> : <p className="picker-muted">Saved custom colors appear here.</p>}</div>
    </div>
    <footer><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn primary" disabled={!valid} onClick={() => { onUse(color); onClose(); }}>Use color</button></footer>
  </dialog>;
}
