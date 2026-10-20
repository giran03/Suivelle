import { useId } from "react";
import { Copy } from "./parts";
import type { AgentClient } from "./types";

/** Actual setup evidence; authentication alone does not verify the first session. */
export function AgentSetupChecklist({ client: c, busy, writable, apiEnabled, onSetup, onCheck }: {
  client: AgentClient;
  busy: boolean;
  writable: boolean;
  apiEnabled: boolean;
  onSetup: (instructions: boolean, commands: boolean) => void;
  onCheck: () => void;
}) {
  const id = useId();
  const hasInstructions = Boolean(c.instructionsPath || c.instructionsPlace);
  const skipInstructions = c.instructionsRequested === false;
  const skipCommands = c.commandsRequested === false;
  const instructionsReady = !hasInstructions || c.instructionsAdded || skipInstructions;
  const commandsReady = c.commands.length === 0 || c.commandsAdded || skipCommands;
  const filesReady = instructionsReady && commandsReady;
  const verified = c.connectionConfigured && Boolean(c.whoamiAt);
  const completed = Number(c.connectionConfigured) + Number(filesReady) + Number(verified);
  const init = c.commands.find((command) => command.endsWith("suivelle_init"));
  const sessionPrompt = `Call suivelle whoami. Report your agent name, permitted workspaces and change mode, and confirm whether your instructions and Agent protocol were returned. If Agent protocol is missing, ${init ? `run ${init}` : 'call command(name="init") and follow its setup steps'}. Do not run project setup or any optional workflow.`;

  return (
    <div className="agx-setup">
      <div className="agx-card-head">
        <h5 id={id}>Setup checklist</h5>
        <span className="agx-meta" role="status">{completed} of 3 complete</span>
      </div>
      <ol aria-labelledby={id}>
        <li>
          <div className="agx-setup-title"><strong>Connection configured</strong><span>{c.connectionConfigured ? "Done" : "Needs attention"}</span></div>
          <p>{c.connectionConfigured ? "The app’s connection, connector and token are in place." : c.detail ?? "Finish adding the connection to this app’s config."}</p>
        </li>
        <li>
          <div className="agx-setup-title"><strong>Instructions and commands</strong><span>{filesReady ? "Done" : "Incomplete"}</span></div>
          <p>{!hasInstructions ? "This app has no known global instructions file." : c.instructionsAdded ? "Session-start instructions are installed." : skipInstructions ? "Session-start instructions were skipped." : c.instructionsPlace ? `Paste the start lines into ${c.instructionsPlace}. Suivelle cannot verify that setting.` : "Session-start instructions are missing or changed."}</p>
          <p>{c.commands.length === 0 ? "Commands are available as MCP prompts." : c.commandsAdded ? "All command files are installed." : skipCommands ? "Command files were skipped." : "Some command files are missing or changed."}</p>
          {writable && <div className="agx-actions">
            {c.instructionsPath && !c.instructionsAdded && <button type="button" className="btn" disabled={busy} onClick={() => onSetup(true, false)}>{c.instructionsRequested ? "Repair instructions" : "Set up instructions"}</button>}
            {c.commands.length > 0 && !c.commandsAdded && <button type="button" className="btn" disabled={busy} onClick={() => onSetup(false, true)}>Set up commands</button>}
          </div>}
          <details className="agx-setup-files">
            <summary>View setup files and start lines</summary>
            {c.instructionsPath && <p>Instructions: <code>{c.instructionsPath}</code></p>}
            {c.instructionsPlace && <p>Paste in: {c.instructionsPlace}</p>}
            {c.commandPaths.length > 0 && <ul>{c.commandPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>}
            <p>Setup preserves your existing instructions and token. Existing command files written by you are left alone.</p>
            {hasInstructions && <Copy text={c.startLines} label={`Copy ${c.name} start lines`} block />}
          </details>
        </li>
        <li>
          <div className="agx-setup-title"><strong>First session verified</strong><span>{verified ? "Done" : "Not verified"}</span></div>
          <p>{verified ? `A successful whoami call was received at ${new Date(c.whoamiAt!).toLocaleString()}.` : !apiEnabled ? "Turn on “Let local agents connect” above, then open a new agent session." : `${c.restart} In a new session, send the check below; then check again here.`}</p>
          {!verified && <Copy text={sessionPrompt} label={`Copy ${c.name} session check`} block />}
          {c.status === "paused" && <p>The agent is paused. Resume it in its agent settings before checking.</p>}
          <button type="button" className="btn" disabled={busy} onClick={onCheck}>Check again</button>
          <p className="agx-meta">Uses retained successful calls since this connection was configured. Cleared activity history requires a new check. Project setup is separate; optional workflows run only when requested.</p>
        </li>
      </ol>
    </div>
  );
}
