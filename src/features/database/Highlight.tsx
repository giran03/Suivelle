import { splitMatches, useSearchTerm } from "./search";

/** Text with the current in-view search marked; plain text when nobody is searching. */
export function Highlight({ text }: { text: string }) {
  const term = useSearchTerm();
  if (!term) return <>{text}</>;
  const pieces = splitMatches(text, term);
  if (pieces.length === 1 && !pieces[0].hit) return <>{text}</>;
  return (
    <>
      {pieces.map((p, i) => (p.hit ? <mark key={i} className="search-hit">{p.text}</mark> : p.text))}
    </>
  );
}
