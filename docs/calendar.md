# Calendar blocks

Insert `/calendar` into a page, then open **Sources** to create or connect a calendar and add database date properties. Each block keeps its own view, sources, colors, timezone and working hours. Month, week, day, agenda and year views are available; narrow blocks use agenda view.

Events are ordinary pages with a schedule block and rich notes. Open an event as a page to write notes, or start with a page template. **Schedule this block** in a block's menu creates a linked event. Linked work sessions have their own times; moving them does not change a database deadline. Moving a database item updates its date property. Undated database records can be scheduled from the list below the calendar.

Multi-day events need a start and a through date; an earlier through date snaps back to the start, and moving the start carries the end with it so the length is kept. The editor shows the event's length and blocks saving an invalid range. Each event can have its own color from **Color** in the editor, using the same picker as elsewhere in the app. By default, multi-day events get an automatic color that stays the same for that event so overlapping ranges are easy to tell apart; single-day events follow their calendar's color. Turn this off per block under **Sources**, or choose **Use automatic** to clear an event's color. A range that wraps across weeks is drawn as several bars, and hovering or focusing any of them highlights all of them. Labels shrink to fit their bar and are hidden when too little room is left; the title remains in the tooltip.

**Quick add** in the new-event editor reads phrases such as "Focus session Mon–Wed 9am", "Review tomorrow 2–3:30pm" or "Call 2026-11-02 at 14:00 for 45 min" and fills in the title and dates; check them before saving. **Duplicate** in the editor starts a new event from a copy. Week numbers and the source color legend appear in the block's options and filter bar. A bar too narrow for its title shows a small dot instead.

Daily, weekly, monthly and yearly recurrence supports an interval, selected weekdays for weekly series, an end date or occurrence count, and cancelled or moved occurrences. Edit or remove one occurrence, this and future occurrences, or the whole series. Monthly series skip months without the chosen day. Timed events retain their local time through daylight-saving changes; invalid or ambiguous local times require choosing another time.

Reminders are delivered while Suivelle is running, including in the tray. They do not run after the application is fully closed. All-day reminders are based on 9 AM in the event's timezone. Completed events stay quiet.

Click anywhere on a day square to select it. The selected day stays open under the grid with its items in time order (all-day first), arrows to step through days, and notes such as "Day 2 of 10" or "Overlaps"; click an item to edit it. The selected-day summary shows planned time, occupied time and overlaps. All-day items, completed events and events marked free do not consume working-time capacity. The daily-note shortcut opens the selected day's journal.

Removing a calendar block removes that view. It preserves its collection and event pages. Trashing the collection hides its events; restore the collection to reconnect it. Workspace archives preserve collections, event schedules and remapped page/block links.

## Calendar files

Import and export `.ics` files from the calendar footer. Export includes the connected native event collections loaded by the block, with notes, reminders and supported recurrence. Database dates are edited at their source and are not included in this export. Use workspace archives for a complete portable copy with internal links.

Import accepts up to 1,000 events in a file under 5 MB, IANA timezones or UTC, and the recurrence forms described above. Unsupported rules are skipped with an explanation. Times have minute precision. Import creates new event pages; importing the same file again creates another copy. Files containing links do not restore those links. Unbounded timezone recurrence can be exported only when the timezone's future transition pattern can be represented safely; otherwise set a recurrence end date.

The calendar bounds native queries to 2,000 event pages and 6,000 displayed occurrences, with a visible notice if truncated. Database sources initially load 1,000 records and support loading more, up to 10,000. Finite recurrence expansion is bounded to 100 years. External calendar synchronization and notifications while the application is closed are outside this version.
