# REA workflow — shared, explicit invocation only

Status: reusable manual workflow for any project and agent. Invoke only when the person explicitly asks to use REA or the REA workflow, for example: “Use the REA workflow to investigate this feature.” A mention in an attachment, prior run, repository, or tool description is not an invocation. Availability does not activate it for ordinary development, debugging or code review.

The installed shared entrypoint is `C:/Users/guill/.agents/skills/rea-workflow/SKILL.md`; its references include this procedure, role prompts and templates. It is available outside this repository. Client-specific invocation controls and global instructions make it explicit-only. It does not install REA, start a run, launch an agent, or enforce isolation.

Use local run files or optional Suivelle pages to investigate one feature, approve a behavioral specification, and hand it to a separate builder. Read the complete procedure before starting. The investigator does not implement the rebuild. A request for REA investigation alone does not authorize a full rebuild.

## Start here

The person chooses the target app/artifact, feature, and destination project. Record whether the investigation permits static inspection only or particular runtime interactions. Do not substitute a nearby app, fixture, or installed program for an unspecified target.

After explicit invocation, copy these templates into a new research run selected for the task. Local files work without Suivelle; a project's Agent Hub is an optional place to track that run, not the location of the shared workflow:

| Page/artifact | Starting template | Readers |
| --- | --- | --- |
| Run brief, behavior rules, evidence ledger | [Research](research.template.md) | Investigator, evidence reviewer, person |
| Rule-by-rule decisions, handoff approval | [Review](review.template.md) | Evidence reviewer, person |
| Behavioral handoff draft | [Specification](SPEC.template.md) | Research side while drafting; builder after approval |
| Test/mutation report, pilot assessment | [Verification](verification.template.md) | Clean verifier, person; results imported afterward |

Use [role prompts](prompts.md) to start each role in the appropriate external session. Prompts in this kit are copied manually; `/suivelle_rebuild` and workflow MCP tools are proposed product features and are not available yet.

Keep the research workspace and artifacts outside the builder's accessible context. Ordinary Suivelle page placement is not an access-control boundary. The simplest pilot uses a file handoff and no Suivelle connection in the builder or verifier session.

## 1. Investigate

1. Fill the research brief with the actual target identity/version/hash, requested feature, investigation boundary, destination, and acceptance goals.
2. Check the selected research agent already has the needed REA tools. If setup is needed, the person follows REA's own setup flow for the intended client/profile and reviews the proposed changes. Do not run setup for other clients automatically.
3. Give the investigator its prompt and brief. It inspects the target, produces behavioral rules with evidence, and records unresolved questions. It does not edit the destination implementation.
4. Preserve portable evidence where the installed REA version supports it. Record incomplete coverage instead of claiming a search found every behavior.

REA's setup and host requirements change; use its [official setup documentation](https://github.com/morluto/rea/blob/main/docs/installation.md). A skill file alone is not confirmation that analysis tools or engines are connected.

## 2. Review evidence and prepare the public spec

Review each rule using its specific evidence, not merely the investigator's summary. Mark it Supported, Needs evidence, Ambiguous, or Rejected. An absent, unrelated, stale, or incomplete citation cannot be Supported. Return unresolved essential rules to research.

Manual review is the default pilot path. If Jev-assisted review is separately chosen, record what selected content may be sent to the provider. Jev narrows review work; it does not replace citation checks or human approval. A service error or unclear response leaves the review pending. No Jev calls are made by this kit.

Write a separate builder-facing spec using stable rule IDs. Keep original source, decompilation, target paths, research transcripts, evidence payloads, and private evidence mappings on the research side. Required user changes may be included as explicit User requirements, without claiming they were observed in the original.

Before approval, remove all unfilled template placeholders. Essential unknowns block approval. Optional omissions must be explicitly excluded from scope. The person reads the actual final spec, not just a summary of the review.

## 3. Approve a frozen handoff

The person says go for one exact spec revision. An agent cannot grant this approval on the person's behalf. Approval is permission to hand off this specification, not permission to merge, publish, or deploy.

Export the builder-facing spec as `SPEC.md` to a fresh directory selected for this handoff. Compute its SHA-256 over the final bytes, then record the digest, run ID, revision, approver, and approval time in the private review record. Exporting or editing the file after approval requires checking the final bytes again and obtaining renewed approval if they differ.

The builder directory contains only:

```text
SPEC.md       Approved behavioral specification
BUILDER.md    Builder role prompt from prompts.md, with clean run identifiers
MANIFEST.md   Run ID, spec revision/hash, approval record, allowed file list
```

`MANIFEST.md` records only clean identifiers, the approved spec hash, who approved it and when, and the three allowed filenames. Keep the evidence-review record and target identity private. A manually written approval record is a declaration; this pilot has no app-enforced approval privileges or tamper-proof audit log.

Compare the exported spec's digest with the approved digest before the builder starts. Use a fresh folder, inspect all its contents including hidden files, and refuse unexpected files or links. Do not copy a whole workspace, mirror, chat export, or research repository into it.

## 4. Build in a fresh external session

Start a separate builder session with the packet and the destination's clean development context. Do not resume, fork with inherited history, or switch models inside the investigation conversation. Do not give this session a Suivelle token, REA connection, shared research memory, or access to the original target.

A fresh conversation on the same unrestricted machine provides procedural separation only. For enforced separation, the external environment must restrict filesystem, connector, and network access to research and routes for reacquiring it. Record which boundary was actually used; do not claim isolation the pilot did not test. See [REA's isolation guidance](https://github.com/morluto/rea/blob/main/docs/installation.md#limit-rea-to-one-project-or-agent-profile).

If the builder needs an unspecified behavior, it writes a question against the rule ID and stops dependent work. A research-side reviewer can investigate and submit a revised spec through approval. Raw evidence never travels back into the builder conversation. If evidence leaks, stop that builder session, record the exposure, and create a new clean handoff.

## 5. Verify and challenge the tests

Use a separate clean verifier session. It receives the approved packet and clean implementation, not the original target. The tests must cover required rules and normal regression checks. Freeze the test revision before the final comparison.

Create at least three distinct meaningful mutants. Each changes one required behavior, still builds/starts, and must fail an intended behavioral assertion. An invalid program, missing dependency, unrelated crash, or equivalent change does not count. Run the same frozen tests on the baseline and every mutant, recording revisions, commands, environment, exit codes, and assertion failures.

Use the run's declared attempt/time limits. Stop at the limit, after repeated lack of progress, on exposure, or when an essential specification gap appears. Do not weaken tests or change the approved behavior to make the run pass. `/goal` is optional client-specific convenience, not a prerequisite or an unbounded loop instruction.

Import clean reports back into the research run after execution. Mark externally supplied results Reported until the person checks them. Suivelle is not executing or independently validating these tests in the pilot.

## 6. Accept and assess the pilot

The person checks the baseline, meaningful mutation failures, unresolved questions, and destination changes. Record acceptance separately from spec approval. Leave merge, release, and publication to their normal explicitly authorized processes.

Complete the assessment in the verification template: time per stage, number of handoffs, repeat work, model/provider choices, costs if available, and any confusing or fragile step. Do not infer total model spend from Suivelle's estimated MCP token counts.

Future app integration may store shared workflow definitions separately from project-specific runs and approvals. It must retain explicit invocation: enabling availability, opening a project, or connecting an agent never starts REA. Optional Jev review and client convenience follow the pilot assessment; neither is a prerequisite for this manual workflow.

## Run status

Track each actual pilot in its private research record and project task list. This reusable kit
does not grant approval to any run. A copied template is not an approved spec or a completed
investigation.
