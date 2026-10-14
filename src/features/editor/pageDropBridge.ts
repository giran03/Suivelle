type DropHandler = (pageIds: string[], x: number, y: number) => boolean;
let handler: DropHandler = () => false;

/** The sidebar stays light; the editor extension installs its handler when it loads. */
export function registerPageDrop(handlerForEditors: DropHandler) { handler = handlerForEditors; }
export function dropPagesOnEditor(pageIds: string[], x: number, y: number) { return handler(pageIds, x, y); }
