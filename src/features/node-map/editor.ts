import { READ_ONLY } from "../../lib/access";
import { ipc, toAppError } from "../../lib/ipc";
import { useWorkspace } from "../../stores/workspace";
import { flushAllEditors } from "../editor/flushRegistry";
import type { MapEdit } from "./model";
import { useNodeMap } from "./store";

/** Map edits use the existing content model; the backend returns a guarded inverse for undo. */
let lock = false;
async function run(edit: MapEdit): Promise<MapEdit | null> {
  if (READ_ONLY || lock) return null;
  lock = true; useNodeMap.setState({ editBusy: true, editError: "" });
  try {
    await flushAllEditors(true);
    const inverse = await ipc.nodeMapEdit(edit);
    useWorkspace.getState().bumpData();
    if (inverse.kind === "blocks") window.dispatchEvent(new CustomEvent("suivelle:map-content-changed", { detail: inverse.changes.map(c => c.pageId) }));
    await useWorkspace.getState().reloadTree();
    useNodeMap.setState(s => ({ refresh: s.refresh + 1 }));
    return inverse;
  } catch (e) { useNodeMap.setState({ editError: toAppError(e).message }); return null; }
  finally { lock = false; useNodeMap.setState({ editBusy: false }); }
}
export async function performEdit(edit: MapEdit) {
  const inverse = await run(edit);
  if (inverse) useNodeMap.setState(s => ({ undo: [...s.undo.slice(-29), inverse], redo: [] }));
  return !!inverse;
}
export async function undoEdit() {
  const undo = useNodeMap.getState().undo;
  const edit = undo[undo.length - 1]; if (!edit) return;
  const inverse = await run(edit);
  if (inverse) useNodeMap.setState(s => ({ undo: s.undo.slice(0, -1), redo: [...s.redo, inverse] }));
}
export async function redoEdit() {
  const redo = useNodeMap.getState().redo;
  const edit = redo[redo.length - 1]; if (!edit) return;
  const inverse = await run(edit);
  if (inverse) useNodeMap.setState(s => ({ redo: s.redo.slice(0, -1), undo: [...s.undo, inverse] }));
}
