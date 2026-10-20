# Research record — [run ID]

State: Draft. This document stays on the research side. Template fields must be filled before the corresponding stage begins.

## Brief

- Run ID / spec revision:
- Feature and observable acceptance goals:
- Target app, version, artifact path, SHA-256 (or the recorded runtime identity):
- Why this target is selected:
- Permitted static inspection:
- Permitted runtime interactions and effects (none unless specified):
- Destination project / integration constraints:
- Explicit exclusions:
- Investigator session / agent / model:
- Evidence reviewer session / agent / model (or person):
- Attempt and elapsed-time limits / escalation point:
- Selected isolation boundary for the later builder:
- Optional Jev review: off / separately chosen; approved payload scope:

## Questions to resolve

| Question | Evidence needed | Answered / partial / unresolved | Remaining limit |
| --- | --- | --- | --- |
| [Question] | [Static, runtime, package resource, etc.] | Unresolved | [Limit] |

## Rule ledger

Repeat this block for each proposed behavior.

### RULE-001 — [behavior]

- Origin: observation / inference / user requirement.
- Required or optional:
- Inputs, preconditions, and trigger:
- Observable output and state changes:
- Boundaries, error handling, persistence, and ordering:
- Evidence references (or the person's instruction for a user requirement):
- What the evidence directly establishes:
- What remains inferred or unknown:
- Acceptance example with input, action, expected output:
- Review disposition: Pending.

## Evidence ledger

| Evidence ID | REA operation and version | Target digest | Source location / capture identity | Observation | Limits | Retained artifact / hash |
| --- | --- | --- | --- | --- | --- | --- |
| [ID returned by REA; do not invent one] | [Operation/version] | [Digest] | [Location] | [Finding] | [Incomplete coverage etc.] | [Portable reference] |

Raw source, disassembly, pseudocode, and identifying paths belong only here or in private evidence attachments. They must not be included in the builder-facing spec. Preserve enough of each result to review it later; a session-only ID that cannot be retrieved is insufficient as the only retained record.

## Exposure and handoff log

| Session / actor | Original or evidence seen? | Permitted role | Event / time |
| --- | --- | --- | --- |
| [Investigator] | Yes | Research only | [Time] |

Evidence-exposed sessions do not become builder or clean verifier sessions. Record accidental exposure and restart the affected clean role rather than hiding the incident.

## Open questions and changes

List unsupported essential rules, proposed scope reductions, and requests from clean roles by rule ID. Keep raw evidence responses private. Changes to approved behavior require a new public spec revision and renewed approval.
