import { useEffect, useRef, useState } from "react";
import { readProfile } from "../lib/motion";
import { Icon, type IconName } from "./Icon";

interface Layer<T> {
  value: T;
  key: number;
}

/**
 * Two things trading places in one slot (transitions.dev icon swap and text states swap). The old value stays for
 * the length of the exit while the new one enters on top, then only the new one is left.
 */
function Swap<T>({ value, render, kind }: { value: T; render: (value: T) => React.ReactNode; kind: "icon" | "text" }) {
  const [layers, setLayers] = useState<Layer<T>[]>([{ value, key: 0 }]);
  const last = useRef(value);
  const seq = useRef(0);
  useEffect(() => {
    if (Object.is(last.current, value)) return;
    last.current = value;
    const key = ++seq.current;
    setLayers((l) => [...l.slice(-1), { value, key }]);
    const timer = window.setTimeout(() => setLayers((l) => l.filter((x) => x.key === key)), Math.round(260 * readProfile().time));
    return () => window.clearTimeout(timer);
  }, [value]);
  return (
    <span className={`t-swap t-swap-${kind}`}>
      {layers.map((layer, i) => (
        <span key={layer.key} className={`t-swap-layer ${i === layers.length - 1 ? (layer.key === 0 ? "rest" : "in") : "out"}`} aria-hidden={i === layers.length - 1 ? undefined : true}>
          {render(layer.value)}
        </span>
      ))}
    </span>
  );
}

/** An icon that cross-fades with a soft blur and a small grow when its name changes. */
export function IconSwap({ name, size, filled }: { name: IconName; size?: number; filled?: boolean }) {
  return <Swap kind="icon" value={name} render={(n) => <Icon name={n} size={size} filled={filled} />} />;
}

/** Text that rises out and in, blurred, when it changes. */
export function SwapText({ value }: { value: string }) {
  return <Swap kind="text" value={value} render={(v) => v} />;
}
