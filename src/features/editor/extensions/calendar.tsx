import { Node, mergeAttributes } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { lazy, Suspense, useEffect, useState } from "react";
const CalendarBlock = lazy(() =>
  import("../../calendar/CalendarBlock").then((m) => ({
    default: m.CalendarBlock,
  })),
);
import { useCalendarComposer } from "../../calendar/store";
import { useWorkspace } from "../../../stores/workspace";
import { ipc, toAppError } from "../../../lib/ipc";
import type { CalendarEvent, CalendarSchedule } from "../../calendar/model";
import { Icon } from "../../../components/Icon";
import { DateTime } from "luxon";
function readData(element: HTMLElement, key: string) {
  try {
    const value = JSON.parse(element.getAttribute(key) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}
function CalendarNode({ node, updateAttributes }: NodeViewProps) {
  return (
    <NodeViewWrapper contentEditable={false}>
      <Suspense fallback={<p className="field-hint">Loading calendar…</p>}>
        <CalendarBlock
          raw={node.attrs.config ?? {}}
          update={(patch) =>
            updateAttributes({ config: { ...node.attrs.config, ...patch } })
          }
        />
      </Suspense>
    </NodeViewWrapper>
  );
}
function EventNode({ node, editor }: NodeViewProps) {
  const page = useWorkspace((s) => s.selectedPage);
  const data = node.attrs.schedule as CalendarSchedule;
  const [error, setError] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    ipc
      .pageTitles((data.links ?? []).map((l) => l.pageId))
      .then(
        (rows) =>
          alive &&
          setTitles(
            Object.fromEntries(
              rows.map((r) => [
                r.id,
                r.deleted ? "Page in trash" : r.title || "Untitled",
              ]),
            ),
          ),
      )
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [data.links]);
  return (
    <NodeViewWrapper contentEditable={false} className="calendar-event-summary">
      <header>
        <Icon name="calendar" />
        <strong>Event schedule</strong>
        {editor.isEditable && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const pageId = editor.view.dom.dataset.contextPage ?? page?.id;
              if (!pageId) return;
              try {
                const owner = page?.id === pageId ? page : await ipc.pageGet(pageId);
                const b = (await ipc.blockList(pageId)).find(
                  (b) => b.id === node.attrs.blockId,
                );
                if (!b)
                  throw new Error(
                    "Save this page before editing its schedule.",
                  );
                useCalendarComposer.getState().show({
                  event: {
                    pageId,
                    blockId: b.id,
                    revision: b.revision,
                    title: owner?.title ?? "Untitled",
                    data: JSON.parse(b.dataJson),
                  } as CalendarEvent,
                });
              } catch (e) {
                setError(toAppError(e).message);
              }
            }}
          >
            Edit schedule
          </button>
        )}
      </header>
      <p>
        {DateTime.fromISO(data.start).toLocaleString(
          data.allDay ? DateTime.DATE_MED : DateTime.DATETIME_MED,
        )}{" "}
        →{" "}
        {DateTime.fromISO(data.end)
          .minus(data.allDay ? { days: 1 } : {})
          .toLocaleString(
            data.allDay ? DateTime.DATE_MED : DateTime.DATETIME_MED,
          )}
        {data.allDay ? " · All day" : ` · ${data.timezone}`}
        {data.recurrence ? ` · Repeats ${data.recurrence.frequency}` : ""}
        {data.completed ? " · Completed" : ""}
      </p>
      {data.location && <p>{data.location}</p>}
      {data.links?.map((l) => (
        <button
          type="button"
          className="link"
          key={`${l.pageId}:${l.blockId}`}
          onClick={() =>
            void useWorkspace.getState().openPage(l.pageId, l.blockId)
          }
        >
          {titles[l.pageId] ?? l.label ?? "Missing reference"}
          {l.blockId ? " · Block" : ""}
        </button>
      ))}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </NodeViewWrapper>
  );
}
export const CalendarNodeBlock = Node.create({
  name: "calendar",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      config: {
        default: {},
        rendered: false,
        parseHTML: (element: HTMLElement) =>
          readData(element, "data-calendar-config"),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="calendar"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(
        {
          "data-type": "calendar",
          "data-calendar-config": JSON.stringify(node.attrs.config),
        },
        HTMLAttributes,
      ),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(CalendarNode, {
      stopEvent: () => true,
      ignoreMutation: () => true,
    });
  },
});
export const CalendarEventBlock = Node.create({
  name: "calendarEvent",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      schedule: {
        default: {},
        rendered: false,
        parseHTML: (element: HTMLElement) =>
          readData(element, "data-calendar-schedule"),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="calendar-event"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(
        {
          "data-type": "calendar-event",
          "data-calendar-schedule": JSON.stringify(node.attrs.schedule),
        },
        HTMLAttributes,
      ),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(EventNode, {
      stopEvent: () => true,
      ignoreMutation: () => true,
    });
  },
});
