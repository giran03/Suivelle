import { useCallback, useEffect, useState } from "react";
import { DateTime } from "luxon";

export const currentCalendarDay = (timezone: string) =>
  DateTime.now().setZone(timezone).toISODate()!;

/** Follow today across midnight only when the user was viewing today. */
export function useCalendarDay(timezone: string) {
  const [state, setState] = useState(() => {
    const today = currentCalendarDay(timezone);
    return { today, day: today };
  });
  const setDay = useCallback(
    (day: string) => setState((previous) => ({ ...previous, day })),
    [],
  );
  useEffect(() => {
    let timer = 0;
    const refresh = () => {
      window.clearTimeout(timer);
      const today = currentCalendarDay(timezone);
      setState((previous) =>
        previous.today === today
          ? previous
          : {
              today,
              day: previous.day === previous.today ? today : previous.day,
            },
      );
      const midnight = DateTime.now()
        .setZone(timezone)
        .plus({ days: 1 })
        .startOf("day")
        .toMillis();
      // The minute heartbeat also catches a changed system clock; focus catches sleep/tray suspension.
      timer = window.setTimeout(
        refresh,
        Math.min(60_000, Math.max(100, midnight - Date.now() + 25)),
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [timezone]);
  return { ...state, setDay };
}
