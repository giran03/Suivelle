import type { GroupSpec, Property } from "../../types";
import { Tag } from "./cells";
import { EMPTY_GROUP, groupLabel } from "./groups";
import { optionById } from "./model";

/** A group's name: a coloured tag for options, plain text for everything else. */
export function GroupLabel({ prop, groupKey, spec }: { prop: Property | undefined; groupKey: string; spec?: GroupSpec | null }) {
  if (prop && groupKey !== EMPTY_GROUP && (prop.type === "select" || prop.type === "status")) {
    return <Tag option={optionById(prop, groupKey)} status={prop.type === "status"} />;
  }
  return <span className="group-name">{groupLabel(prop, groupKey, spec?.bucket)}</span>;
}
