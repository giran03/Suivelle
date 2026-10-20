# Verification report — [clean run ID]

State: Not run. Provenance: externally reported until the person reviews or reproduces the execution. No result in this template is evidence that a command ran.

## Inputs and environment

- Approved spec revision / SHA-256:
- Implementation repository / revision:
- Frozen tests revision:
- Verifier session / actor / reported model:
- Toolchain / OS / relevant environment:
- Isolation boundary actually used:
- Original/evidence exposure incidents (none only if checked):
- Start/end time and configured attempt/time limits:

## Baseline

| Required rule or regression | Command / test identity | Actual exit code | Assertion/result | Retained output / digest |
| --- | --- | --- | --- | --- |
| [Rule/check] | [Command] | Not run | Not run | [Output] |

All mandatory rules and required destination regression checks must pass. Skipped checks remain explicitly unverified.

## Meaningful mutants

| Mutant / revision | Required rule | Deliberate behavioral change | Build/start result | Same frozen test / actual exit | Intended assertion failure | Counts? |
| --- | --- | --- | --- | --- | --- | --- |
| M1 | [Rule] | [One change] | Not run | Not run | [Required evidence] | No |
| M2 | [Different behavior/change] | [One change] | Not run | Not run | [Required evidence] | No |
| M3 | [Different behavior/change] | [One change] | Not run | Not run | [Required evidence] | No |

A mutant counts only if it remains a valid runnable implementation and the frozen tests reject the intended broken behavior. Syntax errors, unrelated crashes, unavailable dependencies, equivalent mutations, and tests edited just for a variant do not count. Replace invalid mutants and keep their failed-attempt history.

## Iteration and unresolved work

| Attempt | Failure or gap | Change made | Same approved behavior? | Outcome / time |
| --- | --- | --- | --- | --- |
| [Attempt] | [Issue] | [Change] | [Yes, or return to spec approval] | [Result] |

Stop at the declared budget, repeated lack of progress, exposure, or an essential specification gap. Never weaken assertions to obtain a pass. Keep baseline/mutant code separate and restore the baseline before reporting completion.

## Acceptance recommendation

- Baseline mandatory checks: Not run.
- Meaningful mutants detected for intended reasons: 0 / at least 3.
- Unresolved blocking behaviors:
- Clean implementation revision ready for review:
- Recommendation: Pending.

The person accepts the result separately. Reported logs and matching hashes do not independently prove execution or parity with an incompletely investigated target.

## Pilot assessment

- Time per stage:
- Handoffs / manual steps / confusing decisions:
- Missing evidence or repeated investigation:
- Model/provider selections and substitutions:
- Observed costs and how measured (Unknown is valid):
- Did the builder receive any original material? How was this checked?
- Did every mutation demonstrate a meaningful test?
- Workflow changes needed before productizing:
- Decision to proceed to workspace settings/run tracking:

Do not use estimated MCP token telemetry as total model usage or spend. This assessment is the gate for the next implementation milestone; copying a template is not a completed pilot.
