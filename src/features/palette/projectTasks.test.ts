import { expect, it } from "vitest";
import type { DatabaseDetail } from "../../types";
import { savedTaskRelations, taskDestinations } from "./projectTasks";

it("resolves project/task relations by IDs across renamed and duplicate database names", () => {
  const projects = { database: { id: "projects" }, page: { id: "pp", title: "Renamed" }, properties: [] } as unknown as DatabaseDetail;
  const tasks = { database: { id: "tasks" }, page: { id: "tp", title: "Renamed" }, properties: [
    { id: "relation", type: "relation", name: "Assigned initiative", config: { targetDatabaseId: "projects" } },
    { id: "self", type: "relation", name: "Subtasks", config: { targetDatabaseId: "tasks" } },
    { id: "deleted", type: "relation", config: { targetDatabaseId: "gone" } },
  ] } as unknown as DatabaseDetail;
  expect(taskDestinations([tasks, projects], { tp: "Work / Tasks", pp: "Work / Projects" })).toEqual([{ propertyId: "relation", databaseId: "tasks", projectDatabaseId: "projects", label: "Work / Tasks → Work / Projects · Assigned initiative" }]);
  expect(savedTaskRelations('{"projectTaskRelationIds":["relation",4]}')).toEqual(["relation"]);
  expect(savedTaskRelations("broken")).toEqual([]);
});
