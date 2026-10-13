import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ColorPicker } from "../../components/ColorPicker";
import { Icon } from "../../components/Icon";
import { ipc, toAppError } from "../../lib/ipc";
import { CHOICES, usePreferences } from "../../stores/preferences";
import { COLOR_ROLES, contrastWarnings, emptyTheme, normalizeThemeColor, supportsOpacity, parseThemeFile, readableText, resolvePalette, type ColorRole, type PaletteMode, type ThemeConfig } from "./theme";
import { useThemes } from "./themes";
import { radioKeys } from "./radioKeys";
import { PALETTE_PRESETS, withAccentPreset } from "./presets";

function ColorRow({ role, label, color, custom, onChange }: { role: ColorRole; label: string; color: string; custom: boolean; onChange: (color: string | null) => void }) {
  const [text, setText] = useState(color);
  const [picker, setPicker] = useState(false);
  useEffect(() => setText(color), [color]);
  const allowOpacity = supportsOpacity(role);
  const normalize = (value: string) => normalizeThemeColor(role, value);
  const invalid = normalize(text) === null;
  return <div className="theme-color-row">
    <div><label htmlFor={`color-${role}`}>{label}</label><span className="set-hint">{custom ? "Custom color" : "Automatic"}</span></div>
    <div className="theme-color-control">
      <button className="theme-swatch" aria-label={`Choose ${label.toLowerCase()}`} title={`Choose ${label.toLowerCase()}`} style={{ background: color }} onClick={() => setPicker(true)} />
      <input id={`color-${role}`} aria-label={`${label} hex color`} aria-invalid={invalid} aria-describedby={invalid ? `error-${role}` : undefined} spellCheck={false} maxLength={allowOpacity ? 9 : 7} value={text} onChange={(e) => { setText(e.target.value); const hex = normalize(e.target.value); if (hex && [7, 9].includes(e.target.value.length)) onChange(hex); }} onBlur={() => { const hex = normalize(text); if (hex) { setText(hex); onChange(hex); } }} />
      <button className="icon-btn" aria-label={`Reset ${label.toLowerCase()}`} title="Reset to automatic" disabled={!custom && !invalid} onClick={() => { onChange(null); setText(color); }}><Icon name="restore" /></button>
    </div>
    {invalid && <p id={`error-${role}`} className="field-error">Enter {allowOpacity ? "#RGB, #RGBA, #RRGGBB or #RRGGBBAA" : "#RGB or #RRGGBB"}. The last valid color stays in the preview.</p>}
    {picker && <ColorPicker initial={color} allowOpacity={allowOpacity} title={label} hint="Use color adds it to your theme draft." onClose={() => setPicker(false)} onUse={(hex) => { setText(hex); onChange(hex); }} />}
  </div>;
}

export function ThemeEditor({ config, onChange, preview, onPreview }: { config: ThemeConfig; onChange: (config: ThemeConfig, mode?: PaletteMode) => void; preview: boolean; onPreview: (preview: boolean) => void }) {
  const choices = usePreferences((s) => s);
  const profiles = useThemes((s) => s.profiles);
  const [mode, setMode] = useState<PaletteMode>(() => choices.theme === "light" || choices.theme === "dark" ? choices.theme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const [name, setName] = useState("");
  const [selectedProfile, setSelectedProfile] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  const file = useRef<HTMLInputElement>(null);
  const colors = resolvePalette(config, mode, choices);
  const warnings = contrastWarnings(colors);
  const customAccent = config.palettes.light.accent !== undefined || config.palettes.dark.accent !== undefined;
  const selectedPreset = PALETTE_PRESETS[mode].findIndex((preset) => COLOR_ROLES.every(([role]) => config.palettes[mode][role] === preset.colors[role]));
  const setColor = (role: ColorRole, color: string | null) => {
    const palette = { ...config.palettes[mode] };
    if (color) palette[role] = color; else delete palette[role];
    onChange({ ...config, palettes: { ...config.palettes, [mode]: palette } }, mode);
  };
  const attempt = (action: () => void, success: string) => {
    try { action(); setMessage(success); } catch (e) { setMessage(e instanceof Error ? e.message : "Could not save the theme. Export it and try again."); }
  };
  const exportTheme = async () => {
    if (exportBusy.current) return;
    exportBusy.current = true; setExporting(true); setMessage(null);
    try {
      const saved = await ipc.exportTheme(JSON.stringify({ format: "suivelle-theme", version: 1, name: name.trim() || "My theme", config }, null, 2));
      setMessage(saved ? "Theme exported." : "Export canceled.");
    } catch (error) { setMessage(`Could not export the theme: ${toAppError(error).message}`); }
    finally { exportBusy.current = false; setExporting(false); }
  };
  const style = Object.fromEntries(Object.entries(colors).map(([key, value]) => [`--${key}`, value])) as CSSProperties;
  return <>
    <div className="set-row">
      <div className="set-text"><div className="set-title">Accent preset</div><div className="set-hint">Changes button, link, selection and focus colors in both palettes.</div></div>
      <div className="seg theme-presets" role="radiogroup" aria-label="Accent preset" onKeyDown={radioKeys}>{CHOICES.accent.options.map((option, i) => <button type="button" key={option.id} role="radio" tabIndex={customAccent ? i === 0 ? 0 : -1 : (config.accent ?? choices.accent) === option.id ? 0 : -1} aria-checked={!customAccent && (config.accent ?? choices.accent) === option.id} className={!customAccent && (config.accent ?? choices.accent) === option.id ? "on" : ""} onClick={() => onChange(withAccentPreset(config, option.id))}>{option.label}</button>)}</div>
    </div>
    <div className="theme-toolbar">
      <div><h3>Custom colors</h3><p className="set-hint">Saved on this device. Edit each palette independently.</p></div>
      <div className="seg" role="radiogroup" aria-label="Palette to edit" onKeyDown={radioKeys}>{(["light", "dark"] as const).map((id) => <button key={id} role="radio" tabIndex={mode === id ? 0 : -1} aria-checked={mode === id} className={mode === id ? "on" : ""} onClick={() => setMode(id)}><Icon name={id === "light" ? "sun" : "moon"} />{id === "light" ? "Light" : "Dark"}</button>)}</div>
    </div>
    <div className="theme-palette-presets" role="radiogroup" aria-label={`${mode} color presets`} onKeyDown={radioKeys}>
      {PALETTE_PRESETS[mode].map((preset, i) => {
        const selected = COLOR_ROLES.every(([role]) => config.palettes[mode][role] === preset.colors[role]);
        return <button type="button" role="radio" tabIndex={selected || selectedPreset < 0 && i === 0 ? 0 : -1} aria-checked={selected} key={preset.id} title={preset.description} onClick={() => onChange({ ...config, palettes: { ...config.palettes, [mode]: { ...preset.colors } } }, mode)}>
          <span className="theme-preset-colors" aria-hidden="true">{[preset.colors.background, preset.colors.sidebar, preset.colors.accent].map((color, i) => <i key={i} style={{ background: color }} />)}</span>
          <span>{preset.name}</span>{selected && <Icon name="check" />}
        </button>;
      })}
    </div>
    <p className="set-hint">Presets replace this palette’s colors. Apply saves your choice and switches the app to {mode} mode.</p>
    <div className="theme-preview" style={style} role="group" aria-label={`${mode} theme preview`}>
      <aside><strong>Suivelle</strong><span>My workspace</span><span className="theme-preview-selected"><Icon name="page" />Daily notes</span><span><Icon name="page" />Ideas</span></aside>
      <div className="theme-preview-main"><div className="theme-preview-top">Daily notes <span>Preview</span></div><article><strong>A space for your thoughts</strong><p>Write a little. Make room for what matters.</p><div className="theme-preview-field">Search your notes…</div><span className="theme-preview-button">Add a note</span></article></div>
    </div>
    <div className="theme-preview-options">
      <label><input type="checkbox" checked={preview} onChange={(e) => onPreview(e.target.checked)} /> Preview changes in the app</label>
      <button className="btn ghost" onClick={() => onChange({ ...config, palettes: { ...config.palettes, [mode]: {} } })}>Reset {mode} palette</button>
    </div>
    <p className="set-hint">Apply saves both palettes and uses the mode of your last preset or custom color edit. Cancel keeps your current mode.</p>
    {(["Backgrounds", "Text", "Accent", "Advanced"] as const).map((group) => {
      const rows = <div>{COLOR_ROLES.filter(([, , category]) => category === group).map(([role, label]) => <ColorRow key={`${mode}:${role}`} role={role} label={label} color={colors[role]} custom={config.palettes[mode][role] !== undefined} onChange={(hex) => setColor(role, hex)} />)}</div>;
      return group === "Advanced" ? <details key={group} className="theme-group"><summary>Advanced colors and states</summary>{rows}</details> : <section key={group} className="theme-group"><h3>{group}</h3>{rows}</section>;
    })}
    {warnings.length > 0 && <details className="theme-contrast"><summary><Icon name="warning" />{warnings.length} contrast {warnings.length === 1 ? "warning" : "warnings"} in the {mode} palette</summary><p className="set-hint">Colors stay exactly as chosen. Review these pairs before applying.</p><ul>{warnings.map(({ fg, bg, minimum, ratio }) => <li key={`${fg}:${bg}`}><span>{COLOR_ROLES.find(([key]) => key === fg)![1]} on {COLOR_ROLES.find(([key]) => key === bg)![1].toLowerCase()}: {ratio.toFixed(2)}:1 (aim for {minimum}:1)</span><button className="btn ghost" onClick={() => setColor(fg, readableText(colors[bg]))}>Use readable text</button></li>)}</ul></details>}
    <section className="theme-library"><h3>Saved themes</h3>
      <label className="set-hint" htmlFor="saved-theme">Choose a saved theme</label>
      <div className="theme-library-row"><select id="saved-theme" value={selectedProfile} onChange={(e) => { const profile = profiles.find((p) => p.id === e.target.value); setSelectedProfile(e.target.value); if (profile) { onChange(profile.config); setName(`${profile.name} copy`); } }}><option value="">{profiles.length ? "Select a theme…" : "No saved themes yet"}</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select><button className="btn ghost" disabled={!selectedProfile} onClick={() => attempt(() => { useThemes.getState().deleteProfile(selectedProfile); setSelectedProfile(""); }, "Theme removed from your library.")}>Remove</button></div>
      <label className="set-hint" htmlFor="theme-name">Save a new theme or duplicate the selected theme</label>
      <div className="theme-library-row"><input id="theme-name" value={name} maxLength={80} placeholder="My theme" onChange={(e) => setName(e.target.value)} /><button className="btn" disabled={!name.trim()} onClick={() => attempt(() => useThemes.getState().saveProfile(name, config), "Theme saved to your library. Apply to keep it active.")}>Save theme</button></div>
      <div className="theme-library-actions"><button className="btn" onClick={() => file.current?.click()}>Import theme…</button><button className="btn" disabled={exporting} onClick={() => void exportTheme()}>{exporting ? "Exporting…" : "Export theme…"}</button><button className="btn ghost" onClick={() => onChange(emptyTheme())}>Reset all custom colors</button></div>
      <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => { const chosen = e.target.files?.[0]; e.target.value = ""; if (!chosen) return; try { if (chosen.size > 128 * 1024) throw new Error("Choose a theme file smaller than 128 KB."); const imported = parseThemeFile(await chosen.text()); useThemes.getState().saveProfile(imported.name, imported.config); onChange(imported.config); setName(imported.name); setMessage("Theme imported. Review the preview, then Apply."); } catch (error) { setMessage(error instanceof Error ? error.message : "Could not read this theme file."); } }} />
      {message && <p className="set-hint" role="status">{message}</p>}
    </section>
  </>;
}
