import { type CSSProperties, type DependencyList, type RefObject, useLayoutEffect, useRef, useState } from "react";

interface IndicatorRect {
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  animate: boolean;
}

const HIDDEN: IndicatorRect = { x: 0, y: 0, w: 0, h: 0, visible: false, animate: false };

/** Measures the active item inside a container and returns position/size styles for a sliding highlight pill. */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  selector: string,
  deps: DependencyList,
  resetKey?: unknown
): { visible: boolean; animate: boolean; style: CSSProperties } {
  const [rect, setRect] = useState<IndicatorRect>(HIDDEN);
  const wasVisibleRef = useRef(false);
  const lastResetKeyRef = useRef(resetKey);

  useLayoutEffect(() => {
    if (lastResetKeyRef.current !== resetKey) {
      lastResetKeyRef.current = resetKey;
      wasVisibleRef.current = false;
    }

    const container = containerRef.current;
    if (!container) {
      wasVisibleRef.current = false;
      setRect(HIDDEN);
      return;
    }

    const measure = () => {
      container.querySelectorAll<HTMLElement>("[data-indicator-target]").forEach((el) => {
        delete el.dataset.indicatorTarget;
      });
      const target = container.querySelector<HTMLElement>(selector);
      if (!target) {
        wasVisibleRef.current = false;
        setRect((prev) => (prev.visible ? HIDDEN : prev));
        return;
      }
      target.dataset.indicatorTarget = "true";
      const cRect = container.getBoundingClientRect();
      const tRect = target.getBoundingClientRect();
      const next: IndicatorRect = {
        x: Math.round((tRect.left - cRect.left + container.scrollLeft) * 100) / 100,
        y: Math.round((tRect.top - cRect.top + container.scrollTop) * 100) / 100,
        w: Math.round(tRect.width * 100) / 100,
        h: Math.round(tRect.height * 100) / 100,
        visible: true,
        animate: wasVisibleRef.current,
      };
      wasVisibleRef.current = true;
      setRect((prev) =>
        prev.visible === next.visible &&
        prev.animate === next.animate &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.w === next.w &&
        prev.h === next.h
          ? prev
          : next
      );
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    const target = container.querySelector<HTMLElement>(selector);
    if (target) observer.observe(target);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, selector, resetKey, ...deps]);

  return {
    visible: rect.visible,
    animate: rect.animate,
    style: {
      transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
      opacity: rect.visible ? 1 : 0,
    },
  };
}
