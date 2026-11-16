/** The formula functions the editor can suggest, plus the small text scanners behind autocomplete. */

export type FormulaFunction = {
  name: string;
  /** How a call reads, e.g. `round(number, digits)`. A trailing `…` marks repeatable arguments. */
  signature: string;
  description: string;
  group: string;
};

const fn = (group: string, signature: string, description: string): FormulaFunction => ({
  group,
  signature,
  description,
  name: signature.slice(0, signature.indexOf("(")),
});

export const FORMULA_FUNCTIONS: FormulaFunction[] = [
  fn("Logic", "if(condition, then, else)", "One value or the other."),
  fn("Logic", "ifs(cond1, value1, cond2, value2, …, else)", "The first condition that holds."),
  fn("Logic", "switch(value, case1, result1, …, default)", "The result of the first case equal to the value."),
  fn("Logic", "and(a, b, …)", "True when all are true."),
  fn("Logic", "or(a, b, …)", "True when any is true."),
  fn("Logic", "not(value)", "Flips true and false."),
  fn("Logic", "iferror(value, fallback)", "The fallback when the value is an error."),
  fn("Logic", "coalesce(a, b, …)", "The first value that is not empty."),
  fn("Logic", "empty(value)", "True when nothing is set."),
  fn("Properties", 'prop("Name")', "The value of a property."),
  fn("Numbers", "round(number, digits)", "Round to digits."),
  fn("Numbers", "floor(number)", "Round down."),
  fn("Numbers", "ceil(number)", "Round up."),
  fn("Numbers", "abs(number)", "Remove the sign."),
  fn("Numbers", "sign(number)", "-1, 0 or 1."),
  fn("Numbers", "mod(number, divisor)", "The remainder, with the divisor's sign."),
  fn("Numbers", "pow(number, exponent)", "Raise to a power."),
  fn("Numbers", "sqrt(number)", "Square root."),
  fn("Numbers", "ln(number)", "Natural logarithm."),
  fn("Numbers", "log10(number)", "Base-10 logarithm."),
  fn("Numbers", "min(a, b, …)", "Smallest."),
  fn("Numbers", "max(a, b, …)", "Largest."),
  fn("Numbers", "sum(a, b, …)", "Total of numbers and lists of numbers."),
  fn("Numbers", "average(a, b, …)", "Mean of numbers and lists of numbers."),
  fn("Numbers", "median(a, b, …)", "Middle value of numbers and lists of numbers."),
  fn("Numbers", "toNumber(text)", "Text as a number."),
  fn("Text", "length(text or list)", "Characters or items."),
  fn("Text", "contains(text or list, item)", "Whether it includes the item."),
  fn("Text", "concat(a, b, …)", "Join values into text."),
  fn("Text", "format(value)", "A value as text."),
  fn("Text", "lower(text)", "Lowercase."),
  fn("Text", "upper(text)", "Uppercase."),
  fn("Text", "trim(text)", "Remove spaces at both ends."),
  fn("Text", "replace(text, find, with)", "Replace the first match."),
  fn("Text", "replaceAll(text, find, with)", "Replace every match."),
  fn("Text", "left(text, count)", "The first characters."),
  fn("Text", "right(text, count)", "The last characters."),
  fn("Text", "mid(text, start, count)", "Characters from a position, counting from 1."),
  fn("Text", "split(text, separator)", "Text into a list."),
  fn("Text", "join(list, separator)", "A list into text; the separator defaults to a comma."),
  fn("Text", "startsWith(text, start)", "Whether it begins with the text, ignoring case."),
  fn("Text", "endsWith(text, end)", "Whether it ends with the text, ignoring case."),
  fn("Text", "padStart(text, length, padding)", "Pad on the left up to a length."),
  fn("Dates", "now()", "This moment."),
  fn("Dates", "today()", "Today's date."),
  fn("Dates", "dateAdd(date, amount, unit)", "Units: minutes, hours, days, weeks, months, years."),
  fn("Dates", "dateSubtract(date, amount, unit)", "Same units as dateAdd."),
  fn("Dates", "dateBetween(date, other, unit)", "How many whole units from other to date."),
  fn("Dates", 'formatDate(date, "YYYY-MM-DD")', "Tokens: YYYY MMMM MMM MM DD HH mm."),
  fn("Dates", "year(date)", "The year."),
  fn("Dates", "month(date)", "The month, 1 to 12."),
  fn("Dates", "day(date)", "The day of the month."),
  fn("Dates", "weekday(date)", "1 for Monday to 7 for Sunday."),
  fn("Dates", "week(date)", "The ISO week number."),
  fn("Dates", "startOf(date, unit)", "Start of the day, week (Monday), month or year."),
  fn("Dates", "endOf(date, unit)", "End of the day, week, month or year."),
  fn("Lists", "first(list)", "The first item."),
  fn("Lists", "last(list)", "The last item."),
  fn("Lists", "at(list, index)", "The item at a position, counting from 0; negative counts from the end."),
  fn("Lists", "unique(list)", "Without repeated items."),
  fn("Lists", "sort(list)", "Items in order."),
];

const BY_NAME = new Map(FORMULA_FUNCTIONS.map((f) => [f.name, f]));

export function findFunction(name: string): FormulaFunction | undefined {
  return BY_NAME.get(name);
}

/** The argument names of a signature, e.g. `["number", "digits"]`. */
export function signatureParams(signature: string): string[] {
  const open = signature.indexOf("(");
  const close = signature.lastIndexOf(")");
  const inner = signature.slice(open + 1, close).trim();
  return inner ? inner.split(/,\s*/) : [];
}

/** Which of a signature's arguments the caret is on, treating a `…` argument as repeating. */
export function activeParam(signature: string, argIndex: number): number {
  const params = signatureParams(signature);
  const rest = params.indexOf("…");
  if (rest >= 0 && argIndex >= rest) return rest;
  return Math.min(argIndex, Math.max(0, params.length - 1));
}

/** Functions whose name starts with (then merely contains) the typed text. */
export function suggestFunctions(prefix: string, limit = 8): FormulaFunction[] {
  const p = prefix.toLowerCase();
  if (!p) return [];
  const starts = FORMULA_FUNCTIONS.filter((f) => f.name.toLowerCase().startsWith(p));
  const rest = FORMULA_FUNCTIONS.filter((f) => !starts.includes(f) && f.name.toLowerCase().includes(p));
  return [...starts, ...rest].slice(0, limit);
}

export function suggestProperties(names: string[], prefix: string, limit = 8): string[] {
  const p = prefix.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(p));
  const rest = names.filter((n) => !starts.includes(n) && n.toLowerCase().includes(p));
  return [...starts, ...rest].slice(0, limit);
}

export function quoteName(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const IDENT_START = /[\p{L}_]/u;
const IDENT_PART = /[\p{L}\p{N}_]/u;

/** Index just past the string whose opening quote is at `open` (the text length when unterminated). */
function stringEnd(text: string, open: number): { end: number; closed: boolean } {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i] === '"') return { end: i + 1, closed: true };
    else i += 1;
  }
  return { end: text.length, closed: false };
}

export type Completion =
  | { kind: "function"; prefix: string; from: number; to: number }
  /** `from`..`to` is the whole text between the quotes; `closed` says whether the closing quote exists. */
  | { kind: "property"; prefix: string; from: number; to: number; closed: boolean };

/** What the caret is completing: a function name being typed, or the name inside `prop("…")`. */
export function completionAt(text: string, caret: number): Completion | null {
  let i = 0;
  while (i < caret) {
    if (text[i] === '"') {
      const { end, closed } = stringEnd(text, i);
      if (!closed || caret < end) {
        // The caret is inside this string.
        const from = i + 1;
        if (!/\bprop\s*\(\s*$/.test(text.slice(0, i))) return null;
        const to = closed ? end - 1 : end;
        const prefix = text.slice(from, Math.min(caret, to)).replace(/\\(["\\])/g, "$1");
        return { kind: "property", prefix, from, to, closed };
      }
      i = end;
    } else {
      i += 1;
    }
  }
  let start = caret;
  while (start > 0 && IDENT_PART.test(text[start - 1])) start -= 1;
  if (start === caret || !IDENT_START.test(text[start])) return null;
  let to = caret;
  while (to < text.length && IDENT_PART.test(text[to])) to += 1;
  return { kind: "function", prefix: text.slice(start, caret), from: start, to };
}

/** The known function whose parentheses hold the caret, and which argument the caret is on. */
export function functionAtCursor(text: string, caret: number): { fn: FormulaFunction; argIndex: number } | null {
  const stack: { name: string; arg: number }[] = [];
  let last = "";
  let i = 0;
  while (i < caret) {
    const c = text[i];
    if (c === '"') {
      const { end } = stringEnd(text, i);
      if (end > caret) break;
      i = end;
      last = "";
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j])) j += 1;
      last = text.slice(i, j);
      i = j;
    } else {
      if (c === "(") {
        stack.push({ name: last, arg: 0 });
        last = "";
      } else if (c === ",") {
        if (stack.length) stack[stack.length - 1].arg += 1;
        last = "";
      } else if (c === ")") {
        stack.pop();
        last = "";
      } else if (!/\s/.test(c)) {
        last = "";
      }
      i += 1;
    }
  }
  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const f = BY_NAME.get(stack[k].name);
    if (f) return { fn: f, argIndex: stack[k].arg };
  }
  return null;
}

/**
 * The part of the formula an error position (in characters, as the backend counts) points at, as
 * UTF-16 offsets for the textarea, plus the line it sits on for display.
 */
export function errorSpan(
  text: string,
  position: number,
): { start: number; end: number; line: string; lineStart: number } {
  const chars = Array.from(text);
  const at = Math.max(0, Math.min(position, chars.length));
  const offset = (n: number) => chars.slice(0, n).join("").length;
  let endChar = at;
  if (at < chars.length) {
    const c = chars[at];
    if (c === '"') {
      endChar = at + 1;
      while (endChar < chars.length && chars[endChar] !== '"') endChar += chars[endChar] === "\\" ? 2 : 1;
      endChar = Math.min(endChar + 1, chars.length);
    } else if (IDENT_PART.test(c) || c === ".") {
      while (endChar < chars.length && (IDENT_PART.test(chars[endChar]) || chars[endChar] === ".")) endChar += 1;
    } else {
      endChar = at + 1;
    }
  }
  const start = offset(at);
  const end = offset(endChar);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", start);
  return { start, end, line: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd), lineStart };
}
