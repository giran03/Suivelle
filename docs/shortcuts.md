# Customize shortcuts

Open **Settings → Shortcuts and input**. Search by action or current binding, or filter by context, customized bindings, conflicts, or unassigned actions.

Click a binding to replace it, or **Add** for another input. Focus the recording field and press the key or mouse button with your modifiers. The click that opens the editor is not recorded. Use the manual selectors for physical keys, special keys, and mouse buttons. **Save binding** applies the input; Escape or **Cancel** cancels editing. If another action uses the same input in an overlapping context, choose another input or explicitly replace its assignment.

**Disable** removes all bindings for one action. Click a binding and choose **Remove binding** in its editor to delete one alternative. **Reset** restores that action's defaults if they do not conflict; **Restore all defaults** restores the complete default map. Visible Settings controls remain available when their shortcut is disabled.

Keyboard bindings default to the logical key produced by your layout. Physical mode follows the key position. Captured numpad inputs retain their location. Modifier-only presses and wheel/multi-button/sequence gestures are not part of this release.

Primary, Middle, Secondary, Back and Forward mouse buttons are supported when delivered to the app. Extended distinct button codes and driver-mapped keyboard inputs can be recorded. Use **Test input** to see what your device delivers. Fn, vendor-specific buttons and OS-reserved shortcuts may be handled before they reach Suivelle. Unmodified primary/secondary/middle clicks require a specific action context; workspace-wide mouse assignments require modifiers for those buttons.

Bindings are saved per device across workspaces. Page-tree selection, tab controls, database grid commands, and writing actions retain their own contexts. Normal text entry, focus movement, modal cancellation, Markdown input rules, dragging and resizing remain built-in.

The desktop app supports configurable **Quick capture from any program** and **Focus Suivelle from any program** keyboard shortcuts. Use each action's **Enable** or **Disable** button; enabling one with no keys assigned restores its default keys. Settings distinguish the requested binding from its active registration and show registration errors. Replacements restore previous bindings if registration or persistence fails. Recording temporarily releases Suivelle's global shortcuts and restores them afterward. Global mouse hooks are not installed.

Keyboard hints in the palette, sidebar, toolbar, editor formatting controls, context menus and reference sheet update with your bindings. Context menus show separate keycaps for an applicable input; pressing a listed shortcut while the menu is open acts on its captured item. Actions without an applicable shortcut have no hint. Browser/showcase builds support local settings and identify global shortcuts as desktop-only.

## Verification limits

Automated tests cover binding matching, context conflicts, typing/IME protections, recording isolation, follow-up mouse suppression, persistence failure, actual TipTap formatting and undo, and native registration rollback/swaps. Browser checks cover settings behavior and widths from 320 to 1440px, all density presets, and 100/150/200% zoom. Real mouse-driver delivery, installed WebView2 default navigation, and global hotkey conflicts with other programs still require desktop hardware checks.


When focus is in the page hierarchy, Ctrl/Cmd+C copies the picked pages, or the focused page if none are picked. Switch workspaces, focus a destination page and press Ctrl/Cmd+V to paste inside it. Focus the hierarchy's blank space or tree controls to paste at the top level, or use the Paste pages at top level button/menu action; this also works in empty workspaces. These two page shortcuts can be rebound. The clipboard stays available for repeated copies within the running app. Nested ordinary pages are included; selecting a parent and its child copies that subtree once. Databases and dashboards cannot be copied by this page copier yet, and skipped nested items are reported. Editor text copy/paste retains its normal behavior.

## New in 0.1.4

| Action | Default |
| --- | --- |
| Open today's note | Ctrl+Alt+D |
| Outline and word count | Ctrl+Shift+O |
| Reopen closed tab | Ctrl+Shift+T |

All three can be rebound like any other workspace action. Shift+click a page mention or link to open it in the side peek.

