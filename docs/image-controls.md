# Image controls

Hover over an image or focus it with the keyboard to reveal its controls. The toolbar offers a private note, left/center/right alignment, caption, crop, full-resolution viewer, download and the complete context menu. Narrow images keep essential actions visible and offer the remaining actions through More.

Drag either side handle to resize proportionally. Escape cancels a drag; a completed drag is one undo step. Double-click either handle (or press Enter when focused) to open precise width controls. More → Set image width also opens these controls. The pixel input has an attached group of responsive 25%, 50%, 75% and Full width choices. Reset image size restores the image's natural size, constrained by its container.

Image selection uses a soft tint instead of block or image outlines. Drag from blank space in `main-scroll` or inside block rows to select whole blocks, including a vertical drag in the gutter. Dragging directly over rendered text keeps normal text selection; Alt-drag selects whole blocks even over text. Task, bullet and numbered lists select item by item, including individual nested items. Other containers are selected with their contents. The selection rectangle scrolls the page near the top and bottom edges. Escape cancels a drag or clears the block selection. Block handles keep their existing behavior.

Right-click any selected block for shared actions: copy, cut, duplicate, move and delete. Moving options appear only where the range can move; alignment appears only for an image-only selection. Read-only pages offer copy and select all. Bulk edits retain block order and support undo; copying and pasting in Suivelle retains attachment identity and image settings. Existing duplicate and move keyboard shortcuts also act on the whole selected range.

Captions and alt text are independent of filenames. Replace image keeps width, alignment, caption, alt text, link and private note, and resets the crop. Links open through an explicit menu action; double-click continues to open the viewer.

The viewer offers Fit, Actual size, zoom buttons, +/- keyboard zoom, 0 to fit, arrow-key panning and pointer dragging when zoomed. Ctrl/Cmd+wheel zooms without changing the page's interface size. Escape, the close button or the backdrop dismisses it.

Cropping is non-destructive, with Freeform, Original aspect ratio, Square, 4:3 and 16:9 presets. Drag the crop selection to move it, resize from its corner, or edit its percentage coordinates with the keyboard. Downloads, clipboard copies and exported cropped assets use source-resolution pixels. The original remains available separately.

Animated GIF, WebP and APNG images retain their frames. Cropping animations is unavailable. Copy still frame explicitly copies a still image; Save original preserves the animation. Image clipboard operations use the native Windows clipboard, and cropped downloads use PNG.

Private notes travel with their image blocks through duplication, undo/history and native backup/restore. Markdown and HTML exports omit them. Read-only pages allow viewing, copying, saving and reading existing notes, with editing and resize controls unavailable.

## Portable exports

Markdown and HTML exports open a preview before the save dialog. Preview and saved source use the same native renderer. Source view shows the actual output; rendered view approximates the destination's formatting. Conversion notices identify omitted notes, derived crop assets, unsupported page links and reduced block formatting.

Simple images use Markdown image syntax. Sized/aligned/linked images use HTML. HTML exports retain captions as figure captions; portable Markdown captions become ordinary paragraphs when re-imported. Percentage widths are emitted as HTML width attributes and depend on the destination renderer's support. Internal image links are resolved to exported page paths when their targets are included; links outside the export are omitted with a notice.

Imported supported HTML is converted into native blocks. Image width, alignment, alt text and links are preserved; scripts, event handlers and unsupported styling are never retained as executable markup. Crops are baked into separate exported PNG files, with no dependency on Suivelle's local attachment protocol. Native archives preserve the richer block metadata.
