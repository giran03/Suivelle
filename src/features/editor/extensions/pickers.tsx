import { useEffect, useState, type ReactNode } from "react";
import { Icon, type IconName } from "../../../components/Icon";
import { toAppError } from "../../../lib/ipc";

/** Runs `load` when `key` changes (nothing while it is null) and keeps its result, or the error message. */
export function useLoaded<T>(key: string | null | undefined, load: (key: string) => Promise<T>): { data: T | null; error: string | null; setError: (m: string | null) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    load(key)
      .then((value) => alive && setData(value))
      .catch((e) => alive && setError(toAppError(e).message));
    return () => {
      alive = false;
    };
    // `load` is a plain ipc call; the key is what decides when to reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { data, error, setError };
}

/** One choice in an embed's picker list. */
export function PickItem({ icon, onPick, children }: { icon: IconName; onPick: () => void; children: ReactNode }) {
  return (
    <li>
      <button type="button" className="dbv-pick" onClick={onPick}>
        <Icon name={icon} />
        <span>{children}</span>
      </button>
    </li>
  );
}
