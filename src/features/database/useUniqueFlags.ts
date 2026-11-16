import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../lib/ipc";
import { useLiveData } from "../../lib/liveData";
import type { Property } from "../../types";
import { needsUnique } from "./validation";

type Flags = ReadonlyMap<string, ReadonlySet<string>>;
const NONE: Flags = new Map();

/**
 * For every property that must be unique, the records that share its value with another record.
 * The backend looks at the whole database (not just the loaded rows); this refreshes a moment after
 * edits settle. A failure just means no duplicate marks.
 */
export function useUniqueFlags(databaseId: string | undefined, props: readonly Property[], version: number): Flags {
  const live = useLiveData();
  const ids = useMemo(() => props.filter(needsUnique).map((p) => p.id), [props]);
  const key = ids.join(",");
  const [flags, setFlags] = useState<Flags>(NONE);
  useEffect(() => {
    if (!databaseId || ids.length === 0) {
      setFlags(NONE);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all(
        ids.map((id) =>
          ipc
            .recordDuplicates(databaseId, [id])
            .then((r) => [id, new Set(r.groups.flatMap((g) => g.records.map((x) => x.id)))] as const)
            .catch(() => [id, new Set<string>()] as const),
        ),
      ).then((entries) => {
        if (!cancelled) setFlags(new Map(entries));
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // `key` stands in for the ids list's identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, key, version, live]);
  return flags;
}
