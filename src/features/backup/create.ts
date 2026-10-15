import { ipc } from "../../lib/ipc";
import { flushAllEditors } from "../editor/flushRegistry";

let pending: ReturnType<typeof ipc.backupCreate> | null = null;

/** Every manual entry point saves all editors and shares an in-flight backup. */
export function createSavedBackup() {
  if (!pending) {
    pending = flushAllEditors(true).then(() => ipc.backupCreate()).finally(() => { pending = null; });
  }
  return pending;
}
