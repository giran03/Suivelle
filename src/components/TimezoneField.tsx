import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import "./timezone-field.css";

export const systemTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Include UTC and persisted aliases, which supportedValuesOf intentionally omits. */
export function availableTimezones(value: string, system = systemTimezone()) {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };
  return [
    ...new Set(
      [
        "UTC",
        system,
        value,
        ...(intl.supportedValuesOf?.("timeZone") ?? []),
      ].filter(Boolean),
    ),
  ].sort();
}

/** Uses the same top-layer placement and dropdown motion as the date pickers. */
export function TimezoneField({
  value,
  onChange,
  label = "Timezone",
  disabled = false,
}: {
  value: string;
  onChange: (zone: string) => void;
  label?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const system = systemTimezone();
  const zones = useMemo(
    () => availableTimezones(value, system),
    [value, system],
  );
  const results = useMemo(() => {
    const words = query.trim().toLowerCase().replaceAll("_", " ").split(/\s+/);
    return zones.filter((zone) =>
      words.every((word) =>
        zone.toLowerCase().replaceAll("_", " ").includes(word),
      ),
    );
  }, [zones, query]);
  const choose = (zone: string) => {
    if (disabled) return;
    onChange(zone);
    picker.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!open || !picker.current || !trigger.current) return;
    const el = picker.current,
      anchor = trigger.current.getBoundingClientRect();
    const zoom =
      parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
    const width = el.offsetWidth,
      height = el.offsetHeight;
    const below = anchor.bottom / zoom + 4;
    const flip = below + height > (window.innerHeight - 8) / zoom;
    el.style.left = `${Math.max(8 / zoom, Math.min(anchor.left / zoom, (window.innerWidth - 8) / zoom - width))}px`;
    el.style.top = `${flip ? Math.max(8 / zoom, anchor.top / zoom - height - 4) : below}px`;
    el.style.transformOrigin = flip ? "bottom left" : "top left";
    search.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const options = list.current;
    const selected = options?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    if (!options || !selected) return;
    // Scroll only this list; scrollIntoView can also scroll and dismiss the enclosing modal.
    const top = selected.offsetTop - options.offsetTop;
    if (top < options.scrollTop) options.scrollTop = top;
    else if (
      top + selected.offsetHeight >
      options.scrollTop + options.clientHeight
    )
      options.scrollTop = top + selected.offsetHeight - options.clientHeight;
  }, [open, active, results]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        !(event.target instanceof Node) ||
        !picker.current?.contains(event.target)
      )
        picker.current?.hidePopover();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <div className="timezone-field">
      <button
        ref={trigger}
        type="button"
        className="timezone-field-trigger"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        popoverTargetAction="toggle"
        onClick={() => {
          setQuery("");
          setActive(Math.max(0, zones.indexOf(value)));
        }}
      >
        <span>{value || system}</span>
        <Icon name="chevron" size={14} />
      </button>
      <div
        ref={picker}
        id={id}
        popover="auto"
        className="popover timezone-picker"
        data-popover=""
        role="dialog"
        aria-label={`Choose ${label.toLowerCase()}`}
        onToggle={(event) => setOpen(event.newState === "open")}
      >
        <input
          ref={search}
          disabled={disabled}
          type="search"
          role="combobox"
          aria-label="Search timezones"
          placeholder="Search region or city…"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={
            results[active] ? `${id}-option-${active}` : undefined
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              setActive((index) =>
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (results[active]) choose(results[active]);
            }
          }}
        />
        <button
          type="button"
          className="timezone-system"
          disabled={disabled}
          onClick={() => choose(system)}
        >
          <span>System timezone</span>
          <span>{system}</span>
        </button>
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label="Available timezones"
          className="timezone-options"
        >
          {results.map((zone, index) => (
            <button
              type="button"
              role="option"
              disabled={disabled}
              key={zone}
              id={`${id}-option-${index}`}
              data-index={index}
              aria-selected={zone === value}
              data-active={index === active || undefined}
              tabIndex={-1}
              onPointerMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(zone)}
            >
              <span>{zone}</span>
              {zone === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
        {!results.length && (
          <p className="timezone-empty" role="status">
            No matching timezones.
          </p>
        )}
      </div>
    </div>
  );
}
