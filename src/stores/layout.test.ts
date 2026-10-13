import { afterEach, expect, it } from "vitest";
import { sidebarHidden, sidebarInvisible, sidebarRail, useLayout } from "./layout";

afterEach(() => useLayout.setState({ compact: false, compactOpen: false, collapsed: false, hidden: false, focus: false, width: null }));

it("keeps narrow navigation temporary while preserving desktop visibility and width", () => {
  const layout = useLayout.getState();
  layout.setWidth(320);
  layout.setCollapsed(false);
  layout.setCompact(true);
  expect(sidebarHidden(useLayout.getState())).toBe(true);
  layout.toggleSidebar();
  expect(sidebarHidden(useLayout.getState())).toBe(false);
  layout.toggleSidebar();
  expect(sidebarHidden(useLayout.getState())).toBe(true);
  layout.setCompact(false);
  expect(sidebarHidden(useLayout.getState())).toBe(false);
  expect(useLayout.getState().width).toBe(320);
  layout.toggleSidebar();
  layout.setCompact(true);
  layout.toggleSidebar();
  layout.setCompact(false);
  expect(sidebarHidden(useLayout.getState())).toBe(true);
});

it("shows navigation when toggled from focus mode in either layout", () => {
  for (const compact of [false, true]) {
    useLayout.setState({ compact, compactOpen: false, collapsed: true, focus: true });
    useLayout.getState().toggleSidebar();
    expect(useLayout.getState().focus).toBe(false);
    expect(sidebarHidden(useLayout.getState())).toBe(false);
  }
});

it("keeps a desktop icon rail and restores its saved expanded width", () => {
  const layout = useLayout.getState();
  layout.setWidth(320);
  layout.setCollapsed(true);
  expect(sidebarRail(useLayout.getState())).toBe(true);
  layout.toggleFocus();
  expect(sidebarRail(useLayout.getState())).toBe(false);
  layout.toggleFocus();
  layout.setCompact(true);
  expect(sidebarRail(useLayout.getState())).toBe(false);
  layout.setCompact(false);
  expect(sidebarRail(useLayout.getState())).toBe(true);
  layout.toggleSidebar();
  expect(sidebarRail(useLayout.getState())).toBe(false);
  expect(useLayout.getState().width).toBe(320);
});

it("fully hides and restores both expanded navigation and the icon rail", () => {
  const layout = useLayout.getState();
  layout.setWidth(320);
  for (const collapsed of [false, true]) {
    layout.setCollapsed(collapsed);
    layout.toggleSidebarVisibility();
    expect(sidebarInvisible(useLayout.getState())).toBe(true);
    expect(sidebarRail(useLayout.getState())).toBe(false);
    layout.toggleSidebarVisibility();
    expect(sidebarInvisible(useLayout.getState())).toBe(false);
    expect(sidebarRail(useLayout.getState())).toBe(collapsed);
    expect(useLayout.getState().width).toBe(320);
  }
});

it("keeps the desktop hide preference when opening temporary narrow navigation", () => {
  const layout = useLayout.getState();
  layout.toggleSidebarVisibility();
  layout.setCompact(true);
  layout.toggleSidebarVisibility();
  expect(sidebarInvisible(useLayout.getState())).toBe(false);
  layout.setCompact(false);
  expect(sidebarInvisible(useLayout.getState())).toBe(true);
  layout.toggleSidebar();
  expect(sidebarInvisible(useLayout.getState())).toBe(false);
});
