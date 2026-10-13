import data from "./emoji-data.json";

/** Unicode Emoji 17.0, fully-qualified sequences. See emoji-data.LICENSE.txt. */
export const EMOJI_CATEGORIES = data.map(group => group.name);
const normalize = (text: string) => text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
const aliases: Record<string, string> = { "🇺🇸": "usa us america", "🇵🇭": "ph philippines", "🇬🇧": "uk britain", "📝": "write notes memo", "🚀": "launch rocket" };
export const EMOJIS = data.flatMap(group => group.items.map(([value, name, subgroup]) => ({
  value, name, category: group.name,
  search: normalize(`${name} ${subgroup} ${group.name} ${aliases[value] ?? ""}`),
})));

export function searchEmojis(query: string, category = "all") {
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return EMOJIS.filter(emoji => (category === "all" || emoji.category === category)
    && terms.every(term => emoji.search.includes(term) || emoji.value.includes(term)));
}
