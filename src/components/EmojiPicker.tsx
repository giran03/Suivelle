import { useId, useMemo, useState } from "react";
import { EMOJI_CATEGORIES, searchEmojis } from "../lib/emojis";
import "./emojiPicker.css";

export interface EmojiPickerProps {
  value?: string | null;
  disabled?: boolean;
  onSelect: (emoji: string) => void;
}
const PAGE_SIZE = 80;

export default function EmojiPicker({ value, disabled, onSelect }: EmojiPickerProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [page, setPage] = useState(0);
  const results = useMemo(() => searchEmojis(query, category), [query, category]);
  const pages = Math.max(1, Math.ceil(results.length / PAGE_SIZE));
  return <div className="emoji-picker">
    <div className="emoji-filters">
      <label htmlFor={`${id}-search`}>Search emoji
        <input id={`${id}-search`} type="search" placeholder="Face, heart, food, Philippines…" value={query} disabled={disabled}
          onChange={event => { setQuery(event.target.value); setPage(0); }}
          onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} />
      </label>
      <label htmlFor={`${id}-category`}>Category
        <select id={`${id}-category`} value={category} disabled={disabled} onChange={event => { setCategory(event.target.value); setPage(0); }}>
          <option value="all">All categories</option>
          {EMOJI_CATEGORIES.map(name => <option key={name}>{name}</option>)}
        </select>
      </label>
    </div>
    <p className="emoji-count" role="status">{results.length.toLocaleString()} {results.length === 1 ? "emoji" : "emojis"}{query ? " found" : " available"}</p>
    <div className="emoji-grid" role="group" aria-label="Choose an emoji">
      {results.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(emoji => <button type="button" key={emoji.value}
        className="emoji-cell" aria-label={emoji.name} aria-pressed={value === emoji.value} title={emoji.name} disabled={disabled}
        onClick={() => onSelect(emoji.value)}><span aria-hidden="true">{emoji.value}</span></button>)}
    </div>
    {!results.length && <p className="emoji-empty">No matching emoji. Try another name or category.</p>}
    {pages > 1 && <div className="emoji-pagination">
      <button type="button" className="btn ghost" disabled={disabled || page === 0} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page + 1} of {pages}</span>
      <button type="button" className="btn ghost" disabled={disabled || page + 1 === pages} onClick={() => setPage(page + 1)}>Next</button>
    </div>}
  </div>;
}
