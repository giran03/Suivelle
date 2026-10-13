import { forwardRef, useCallback, useRef } from "react";
import { dissolve } from "../features/motion/dissolve";
import { Icon } from "./Icon";

type Props = React.InputHTMLAttributes<HTMLInputElement> & {
  /** Classes for the box around the field, for placing it (the field keeps its own className). */
  wrapClassName?: string;
};

/** Sets a controlled input's value the way typing would, so React hears about it. */
function setNativeValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A text field with a clear button that dissolves what was typed. It must be controlled (give it `value` and
 * `onChange`): clearing writes the empty value through the same event typing would.
 */
export const SearchField = forwardRef<HTMLInputElement, Props>(function SearchField({ wrapClassName = "", style, ...props }, forwarded) {
  const inner = useRef<HTMLInputElement | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const setRef = useCallback(
    (el: HTMLInputElement | null) => {
      inner.current = el;
      if (typeof forwarded === "function") forwarded(el);
      else if (forwarded) forwarded.current = el;
    },
    [forwarded],
  );
  const has = String(props.value ?? "").length > 0;

  const clear = () => {
    const input = inner.current;
    if (!input || !input.value) return;
    const text = input.value;
    setNativeValue(input, "");
    input.focus({ preventScroll: true });
    if (host.current) void dissolve(host.current, input, text);
  };

  return (
    <span ref={host} className={`sf ${wrapClassName}`.trim()}>
      <input {...props} ref={setRef} style={has ? { ...style, paddingRight: 30 } : style} />
      {has && (
        <button type="button" className="sf-clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
});
