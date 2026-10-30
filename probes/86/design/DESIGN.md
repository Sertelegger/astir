# #86 redesign: alert a Claude permission prompt sooner, and clear it on Esc

Judge's report on the four-candidate panel. Every number below marked
"measured" comes from one harness run unchanged on every tree (section 10). No
code was committed. The spec was read, not edited.

## 1. The problem

Claude shows a permission dialog about 0.8 s after the tool call. astir blocks
on the `permission_prompt` Notification, and Claude sends that only after the
user has been idle at the dialog for 6 s: 6.2 to 6.6 s after the
PermissionRequest. PSH-16's 5 s dwell then runs on top, so the alert lands
about 11.5 s after the dialog appears. Esc at a dialog fires no hook at all.
A dismissed prompt therefore stays blocked, and reminds every minute, until
the agent does something else. On main (07c3935) the Notification names no
agent, so it blocks the main agent.

The held attempt (96d3367) began blocks from the PermissionRequest and from
the `claude agents --json` listing, and tried to say which agent each dialog
belonged to. Two signals name no agent: the listing's "permission prompt" and
the Notification. The PermissionRequest names no call. Each heuristic that
joined them opened new failure timelines over four review rounds: a false
`resolved` while the dialog was up, a real dialog never alerted, stopped
agents shown as working, and a dropped `agent_needs_input`. The redesign must
alert sooner and clear on Esc without that join.

## 2. The candidates, compared

- **A (session-level).** A listing sighting or the Notification blocks the
  session, shown on the main row. PermissionRequests date the block. A digest
  of the call ends it.
- **B (correlate).** Each PermissionRequest is tied to its PreToolUse. A model
  of Claude's dialog queue (FIFO, read from the binary) names the agent whose
  dialog is on screen. It adds a new `PostToolBatch` hook.
- **C (minimal).** Only the Notification blocks, on the main row as today. The
  block is dated back, and the listing's `idle` ends it. C's recommended
  variant is C0, dated `N − 5 s`, which needs no new hook. C+busy adds a clear
  on `busy` after a dialog was seen.
- **D (free).** Like A, but the dwell counts only proven time: the dialog must
  be seen again after the dwell. The Notification proves 5 s on its own. An
  ask ledger ends the dialog when the asking call finishes. D+ adds one
  confirming listing poll.
- **C+ (the judge's synthesis, prototyped and measured).** C0, plus five of
  D's rules, a lighter form of B's decay rule, and a 2 s settle. Apart from
  the settle, it is a subset of D: everything except the blocks the listing
  begins and the ask ledger.

Latency is measured from the dialog becoming visible. In the "user typing"
column the Notification comes at the 12 s check, because the user touched that
terminal. The catalogue is 25 timelines, listed in section 9.

| Candidate | Alert latency (normal / user typing) | Catalogue (of 25) | Registry code lines vs main's 508 | Main risks |
|---|---|---|---|---|
| main 07c3935 | ~11.2 / ~17 s (designers' measure, not re-run) | not run | 0 | Esc never clears. Approvals of long tools keep reminding. |
| held 96d3367 | 5.2 / 5.2 | 15 | +183 | The round-3 findings. Early answers alert in 29 of 50 runs. |
| A | 5.2 / 5.2 | 23 | +288 | Early answers alert in 29 of 50 runs, as held does. A stale self-denied ask skips the dwell: 14 of 30 runs alert after the dialog was answered (new). |
| B, evidenceDwell, no PostToolBatch | 6.2 / 5.2–10.2 | 24 | +278, plus a 121-line correlator | Names a background agent for the whole dialog in 12 of 45 R1-rev runs. |
| B, evidenceDwell, with PostToolBatch | 6.2 / 5.2–10.2 | 25 | as above, plus a hook | PostToolBatch was never captured live. Its body carries all tool I/O (1 MiB limit). Older Claude versions may not know it. FIFO comes from a minified binary. |
| C0 | 6.2 / 12.2 | 16 | +60 (prototype, all variants) | Keeps reminding after an approval. A fan-out sibling or a FileChanged sends a false `resolved`, and the dialog is never re-alerted. |
| C0+busy | 6.2 / 12.2 | 21 | ~+65 | Fan-out and FileChanged: false `resolved`, never re-alerted. |
| D | 6.2 (5.2 in 1 of 10 phases) / 5.2–10.2 | 24 | +289 | The same input from another agent ends the dialog falsely, then re-alerts. A 5000 = 5000 ms boundary is a cliff. Needs the PermissionRequest hook. |
| D+ (as wired) | 6.2 (5.2 in 1 of 10) / 6.2 | 24 | +289 | As D. The claimed 5.2 s needs extra wiring (section 3). |
| **C+ (recommended)** | **6.2 / 12.2** | **24** | **+87 in the prototype** (includes unused variants and switches; a clean version is smaller) | Begins a block only on the Notification. An approval clears within one poll, not at once. |

Notes on the fails that are not lost alerts:

- C0's S1 fail is `resolved` for dialog A at 61 s, then `blocked` for B at 67
  s. That is a flicker between two dialogs. The probe's assertion counts it,
  and main fails it the same way.
- C+, C0 and C0+busy fail S3 notice=false: a 26 s subagent dialog that never
  gets a Notification. That happens only if the user keeps typing in that
  terminal the whole time. Main fails it too.
- B's R1-rev fail names the wrong agent's row. The session still alerts.

## 3. Where the designers' scorecards were wrong

I re-ran the riskiest cases myself: F1/S1, F2/S2 and S2c, F4/S4, R1, R6, the
self-denied background ask, and the baselines. My harness was calibrated
first. On held it reproduces the README's quoted stories byte for byte: S1,
S1-control, S2 in both variants, and S2c. S3 and S8 match the held column of
the designers' scorecards. RY matches except that the alert comes 1 s earlier,
because my harness pulses every second.

| Designer | Claim | Measured | Verdict |
|---|---|---|---|
| A | Risk 1: early dating "is never a false alert" | A self-denied background ask up to 10 s before the dialog dates the block early and holds it after the user's answer. Dialog answered 2 to 4 s after it appeared: 14 of 30 runs alert after the answer, then send `resolved`. Held: 0 of 30. | **Wrong.** A regression A introduces, missing from its scorecard. |
| A | (ii') Esc at 4 s is "the same as 96d3367" | Esc or approval at 1, 2, 3, 4 and 4.5 s: 2, 4, 6, 8 and 9 of 10 phases alert. That is 29 of 50 per kind, identical to held. | Right. A conceded it. |
| B | R1-rev without PostToolBatch misnames in 20 of 60, "nothing is lost" | 12 of 45. The background agent's row reads blocked for the dialog's whole 60 s, and main's reads tool-running. The session alert is not lost. | Right. |
| B | S8, S3 corrections, R6, early-answer sweep with evidenceDwell | S8 `B:main@7 R@21 B:SUB@27 R:SUB@41`. S3 is corrected at the Notification. R6: 0 of 120 bad. Early answers: 0 of 50. | Right. |
| C | "None of the held design's failure modes can occur in C" | **Fan-out** (new timeline): main runs two subagents in parallel. SUB1's dialog is up from 2.4 to 60 s. SUB2 finishes at 15 s, after the Notification. Every C variant, +busy included, sends `resolved` at 15 s and never re-alerts SUB1's dialog. The same at 30 s. Held, A, B and D pass. | **Wrong.** Inherited from main, but it is the README's top failure class and it is absent from C's scorecard. |
| C | FileChanged gives a false `resolved`; 0.95 to 1.95 s over the 5 s target | Confirmed: `B@7, R@10` with the dialog up to 60 s. Latency 6.2 s in 10 of 10 phases. | Right. |
| D | D+ alerts "5.2 s in all phases" | D's harness calls `dialogCheckDue()` every 100 ms. The daemon (`main.ts`) checks it once per 1 s tick, and the confirming poll lands after that tick's pulse. Measured as wired: 6.2 s in 9 of 10 phases, the same as D. | **Wrong as wired.** Fixable by pulsing after the confirming poll lands. |
| D | (iii-e) approval at 5.5 s: 0 of 10 alerts | 2 of 10. Both are legitimate, because the dialog did last past the dwell. | Minor. |
| D | Risk 2: identical calls can end each other's asks | Confirmed. SUB's dialog is up from 1.8 to 60 s, and SUB2 runs the same command, auto-approved. Result: `B@8, R@15` (false), `B@23`, `R@63`. | Right, and it is D's one catalogue fail. |
| All four | S1, S2, S2c, S4, R1, R6 and the self-denied background ask | Each candidate's stories match its scorecard. R6: 0 lost, 0 background alerts and 0 false `resolved` for A, B, C and D. Held: 20 and 20. | Right. |

**The latency argument for the ledger does not hold.** With a Notification,
C0, C+, D and B with evidenceDwell all alert 6.2 s after the dialog appears.
Each of them alerts on the first pulse after the Notification. D is faster
only when the Notification is late or missing, which happens when the user is
typing in that terminal. A is faster (5.2 s) only because it does not prove
the dwell, and that is what produces its early-answer false alerts.

## 4. Recommendation: C+

Ship C+. Keep D as the documented upgrade path.

**Why C+:**

1. **Same outcome as D on 24 of 25 timelines.** The one difference is S3
   notice=false. C+ also passes D's one fail (identical input). Both have the
   same 6.2 s alert on the normal path. Both send zero false alerts on early
   answers.
2. **No new hook in the dialog path.** C+ does not subscribe PermissionRequest.
   Claude awaits that hook before it shows every dialog (5 s timeout), so A, B
   and D add one more await there (G6), and B adds a second hook. C+ also
   changes nothing in the event contract or the adapter.
3. **No attribution and no ledger.** There is no call digest, no claim, and
   nothing to match between agents. That join is what failed four review
   rounds.
4. **About a third of the code.** The prototype adds 87 registry lines,
   variants and switches included. A, B and D each add about 280 to 290.
5. **Its timing boundary fails gracefully.** C+ measures the dwell as elapsed
   time from `N − 5 s`. If the dwell were ever raised above 5 s, the alert
   would come later, not never. D's proof freezes at exactly 5000 ms, so in the
   same case every alert with no listing poll behind it would be lost
   (discovery down, masked sessions). Both were checked in the code.
6. **Every rule but one came from a designer, and all were measured.** The
   exception is a 2 s settle the judge added (below). C+ churns the same 4
   tests of main's suite as C0 does, because they model a Notification that
   arrives less than 5 s after the PreToolUse.

**What C+ gives up against D:**

- With the user typing at that terminal, the alert comes at 12.2 s, not 5.2
  to 10.2 s.
- A dialog that never gets a Notification is never alerted (S3 notice=false).
  Main has the same gap.
- An approval clears at the next listing poll (1 to 6 s), not at once.
- Nothing names the subagent. A and D do not either.

**Why not the others:**

- **A** is D's architecture without D's proof-gated dwell. It brings back
  held's early-answer false alerts and adds the stale-ask false alerts. D
  dominates it.
- **B** is the only design that names the subagent. Naming buys nothing you
  can act on: focus is per pane (PSH-11), and the envelope never shows an
  agent. B also depends on a hook nobody has captured, and on Claude's
  internal queue order read from a minified binary. It is the largest change.
- **D** is sound and measured. It is the upgrade if alerts without the
  Notification ever matter. It must first take A's `(agentId, digest)` match
  and fix D+'s wiring.
- **C0 as proposed** has the fan-out and FileChanged false `resolved`s, and it
  keeps reminding after approvals.

**What was grafted, and from where:**

| Graft | Source |
|---|---|
| Date the Notification's block `N − 5 s`; no PermissionRequest hook | C (C0) |
| Listing `idle` ends the block (Esc) | C, rule 2 |
| Listing `busy`, after a dialog was seen in this block, ends it (answered) | C+busy, and D's E2 |
| The Notification also counts as a sighting of the dialog | D, R3 |
| While the listing is live, main's own progress and FileChanged do not end the block | D, B1 |
| With no live listing, fall back to main's rule | D, E5 |
| Agents mid-tool do not idle-decay while the screen shows a permission dialog | B, R9 (lighter form) |
| A `busy` poll counts only if it began at least 2 s after the latest sighting | the judge (measured below) |

Two details were added during judging, and both were measured:

- **The sighting graft.** Without it there is a hole. Suppose no poll begins
  between the dialog's opening and its Notification (a failed listing spawn),
  and the user approves right after the alert. The block then never clears
  while the listing reads `busy`. Measured: still blocked at 110 s without the
  graft, `resolved` at 11 s with it. A and D have a milder form of the same
  gap: they fall back to the tool's PostToolUse, which came at 100 s.
- **A 2 s settle on the `busy` clear.** The graft alone opens a narrower hole.
  AskUserQuestion's listing reads `busy` until about 7 to 8 s, and its
  Notification lands at about 6.6 s. A poll that begins in that gap reads
  `busy` after the sighting, and it would end the block for a question that
  is still on screen. Measured with the listing busy to 8 s: a false
  `resolved` 1 s after the alert, never re-alerted, in 2 of 10 phases.
  Counting a `busy` poll only when it began at least 2 s after the latest
  sighting closes it: 0 of 10 at both 7 s and 8 s of lag. The missed-poll case
  still clears at 11 s, and all 47 other judged rows are unchanged. D avoids
  this differently: its Notification adds proof, not a "seen waiting" mark.

## 5. The rules of C+

**Scope.** C+ applies to a provider that declares
`promptNoticeAgeMs > 0` and `listingEndsPermissionBlocks`. Claude declares
5000 ms and true. Codex declares 0 and false and keeps main's path. The
registry reads only those capabilities and the lister's translated `screen`
(CAP-02).

**State.** Three fields per session, in memory only, never persisted and on
no surface:

- `dialogSeenAt`: the latest poll start, or Notification time, that saw a
  dialog.
- `informativeAt`: the latest poll start that read a permission dialog,
  at-prompt or working.
- `screenNow`: the latest screen.

There are no per-agent fields and no ask records. Polls carry `observedAt`,
the time the poll started (96d3367's `pollInto`).

1. **Begin.** Only a blocking Notification begins a block
   (`permission_prompt`, `agent_needs_input`, `worker_permission_prompt`). It
   blocks the agent it names. Claude's Notification names none, so that is the
   main agent. This is unchanged from main. The listing never begins a block,
   and PermissionRequest is not subscribed.
2. **Date.** A `permission_prompt` Notification at N that moves an agent into
   `blocked` dates the block `N − promptNoticeAgeMs`. The date is never before
   the agent's previous state began (MOD-05 banks up to it). A duplicate on an
   agent that is already blocked changes nothing.
3. **Sighting.** That Notification sets
   `dialogSeenAt = max(dialogSeenAt, N)`. A poll begun at P that reads
   `permission-dialog` or `other-dialog` sets `dialogSeenAt = max(…, P)`.
4. **Esc.** A poll begun at P, at least 1 s after a `permission_prompt`
   block's date, that reads `at-prompt` ends every such block in the session.
   The agent goes to `waiting`.
5. **Answered.** A poll begun at P that reads `working` ends a
   `permission_prompt` block when the earlier `dialogSeenAt` is no earlier
   than the block's date and P ≥ `dialogSeenAt` + 2 s. The agent goes to
   `tool-running`. The 2 s settle covers AskUserQuestion, whose listing still
   reads `busy` just after its Notification.
6. **Hold.** While main is blocked on `permission_prompt` and `informativeAt`
   is within the last 12 s, main's own `pre_tool`, `post_tool`, `tool_failed`
   and `subagent_start` do not change its state. A `file_changed` never ends a
   `permission_prompt` block. `stop`, `session_end` and `session_start` end it,
   as on main.
7. **Degraded.** With no informative reading in 12 s, main's own progress
   ends the block, as on main. That covers discovery being down, an unlisted
   session, and a session masked by "input needed".
8. **Other reasons.** `agent_needs_input` and `worker_permission_prompt` keep
   main's rules: the last reason wins, and rules 4 and 5 do not end them.
9. **Decay.** An agent in `tool-running` is not idle-decayed while the
   session's latest screen is `permission-dialog`. Nothing else in `tick()`
   changes. 96d3367's session-wide skip is gone (F4).
10. **Alert.** The loop is unchanged. The dwell (Claude 5 s) is
    `now − stateSince`, so the first alert goes out on the first pulse after
    the Notification. `resolved` goes out on the next pulse after rule 4, 5 or
    7, only if the block was announced.

**Who is named.** The session's main agent, as on main. Focus is per session
and pane, so "take me there" lands on the dialog.

**What C+ was not measured on.**

- Parallel dialogs with a gap between them, plan approval, and AskUserQuestion
  dismissed with Esc.
- Codex in my harness. Main's existing Codex tests pass with the switches on.
- DMN-06 restore, G4 totals beyond the cases above, and remote daemons.
- No mutation run and no review round. It was measured once, by its author.
- The 2 s settle is sized from the brief's AskUserQuestion lag (`busy` until
  about 7 to 8 s). It was not measured for plan approval or MCP elicitations.
- The degraded fan-out case gives a false `resolved` at 15 s with discovery
  down or a masked session. A, C0 and D share this; B and held do not.

## 6. Spec items that change

The spec has no §14; its sections end at §12, the decision record.

- **MOD-04.** "`blocked` … exited on the next tool event." Amend: a provider
  whose listing ends permission blocks ends a `permission_prompt` block when
  the listing reads at-prompt (→ `waiting`) or working after a dialog
  (→ working), or when the agent's turn ends. While the listing is live, the
  agent's own tool events and FileChanged do not end it. Without a live
  listing, the next tool event ends it, as now.
- **MOD-04 (idle).** Add: an agent mid-tool is not idle-decayed while its
  session's screen shows a permission dialog.
- **MOD-05 / G4.** A block may be dated earlier than the event that reported
  it, by a declared provider capability, never before the previous state
  began. Blocked time is banked from that date.
- **PSH-16.** The dwell is still measured from when the block started. For a
  provider that declares a notice age, the start is the Notification minus
  that age. On the Notification path the dwell is then satisfied by
  construction: Claude's own 6 s idle check does the work. State the
  invariant `promptNoticeAgeMs ≤` the provider's measured minimum notify delay
  (6 s), and pin it with a capture test. If Claude ever notifies sooner, the
  dwell is gone.
- **PSH-10.** "A new block alerts again." Clarify that back-to-back dialogs
  with no gap on screen are one block. An acknowledgement carries over, and
  reminders continue (open question Q3).
- **PSH-01 / PSH-11.** No text change. Add a note that a Claude permission
  block is shown on the session's main agent.
- **§6 capability matrix.** Add two rows: "Prompt notice age (block dated
  back)" (Claude 5 s, Codex 0), and "Listing ends permission blocks" (Claude:
  at-prompt means Esc, working after a dialog means answered; Codex: none).
- **DMN-05.** The listing becomes a clearing signal as well as a discovery
  route. Rows carry `screen`, derived from `status` and `waitingFor`, and
  polls carry the time they started.
- **A1 (consumed hooks).** Unchanged for C+. A, B and D would add
  PermissionRequest, and B would add PostToolBatch.
- **§12 decision record.** Add an entry: why per-agent attribution was dropped
  for Claude permission dialogs, and why PermissionRequest is not subscribed.

## 7. Open questions only you can answer

**Q1. Ship C+ now, or D?**
D alerts without the Notification: 5.2 to 10.2 s against 12.2 s while you are
typing in that terminal. It also clears an approval at once, not within a
poll. It costs about 200 more registry lines, the PermissionRequest hook in
front of every dialog, and a call-digest ledger, and it changes PSH-16 to
"seen after the dwell".

- (a) **C+ now, D later only if the typing case matters. (Recommended)**
- (b) D now, with A's `(agentId, digest)` match grafted in.
- (c) D+ now, with the confirming poll followed by a pulse: 5.2 s when the
  listing is fast.

**Q2. Should an alert name the subagent?**
Only B can. Alerts never show an agent name, and focus is per pane. B needs
the PostToolBatch hook captured live, and a version check, before it could
ship.

- (a) **Show the session's main row as blocked. (Recommended)**
- (b) Pursue B: capture PostToolBatch first.

**Q3. Back-to-back dialogs: one block or one per dialog?**
C+, A and D treat dialogs with no gap on screen as one block: one alert, then
the PSH-02 reminders, and an acknowledgement carries over. Per-dialog alerts
need asks with an identity (D's ledger or B's queue).

- (a) **One block. Amend PSH-10's wording. (Recommended)**
- (b) Re-alert each dialog. This needs D or B.

**Q4. Does Esc end an `agent_needs_input` block?**
What the listing shows for one is unmeasured.

- (a) **Keep main's rule: it lasts until the agent's next event.
  (Recommended until measured)**
- (b) End it when the listing reads at-prompt.

**Q5. Run the capture checklist below before implementation?**

- (a) **Yes. (Recommended)** C+ leans on the listing's `busy` and `idle`
  wording and on Claude's 6 s Notification check.
- (b) Build first and capture in review.

## 8. Measure before building

1. The Notification's timing and the `lastInteraction` reset on the current
   Claude build. Pin both in a capture test.
2. That the listing reads `busy` within one poll after an approval, and `idle`
   after Esc. Check this for Edit, Write, WebFetch, MCP and plan-approval
   dialogs, not just Bash.
3. How long the listing keeps reading `busy` after the Notification, for
   AskUserQuestion, plan approval and MCP elicitations. This sizes rule 5's
   2 s settle.
4. What the 4 of 13 sessions reading `waiting`/"input needed" were. A masked
   session puts C+ (and A and D) in degraded mode.
5. What the listing shows for `agent_needs_input`.
6. For the D upgrade only: whether PostToolUse carries `tool_input` unchanged,
   and whether a subagent's PermissionRequest carries `agent_id`. B read yes
   from the binary; it was never captured.

## 9. The catalogue (measured)

The realistic corpus gives every call its own PreToolUse, `tool_use_id` and
input. A second run used the probes' original shared input. It gave the same
verdicts for A, B, D and C+ on every probe row. Recommended configurations: B
with evidenceDwell, C0 dated `N − 5 s`, and D without D+ unless named.

| Timeline | held | A | B | B + batch | C0 | C0+busy | D | D+ | C+ |
|---|---|---|---|---|---|---|---|---|---|
| S1 (F1, VR3-86-1) | ✗ | ✓ | ✓ | ✓ | ✗¹ | ✗¹ | ✓ | ✓ | ✓ |
| S1-control | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S2 dead=false | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S2 dead=true (F2, F3) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S2c (F2) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S3 notice=true | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3 notice=false | ✓ | ✓ | ✓ | ✓ | ✗² | ✗² | ✓ | ✓ | ✗² |
| S8 | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| RY (VR3-86-1) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S4 (F4) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S4b (F4) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| S5 (F5) | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| R1, 5 timings | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| R6 sweep, 120 runs | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| R1-rev sweep, 45 runs | ✓ | ✓ | ✗³ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Self-denied ask alone, 4 runs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Stale ask + early answer, 30 runs | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Esc at 20 s clears within a poll | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Early answer ≤ 4.5 s, 100 runs | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| (iii) approval + long tool | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| (v) subagent approval + long tool | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ |
| Fan-out, 2 runs (new) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| FileChanged in a dialog (new) | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ |
| Identical input, other agent (new) | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✓ |
| AskUserQuestion after Bash, 3 runs | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Passed (of 25)** | 15 | 23 | 24 | 25 | 16 | 21 | 24 | 24 | 24 |

¹ A flicker between two dialogs (`resolved` A, then `blocked` B 6 s later),
not a loss.
² A dialog that never gets a Notification.
³ The wrong agent's row reads blocked. The session still alerts.

Pass criteria are in `judge/tally.py`. Briefly, a row passes when:

- no `resolved` is sent while that dialog is up, and no real dialog is left
  unalerted;
- no self-denied or approved agent is alerted;
- the dialog clears within one poll of its end;
- a stopped subagent decays.

Degraded listing (discovery down, or masked by "input needed"), measured:

- **Same on every tree:** a lone dialog alerts at 7 s and clears at 21 s on
  approval. Esc sticks, as on main.
- **Fan-out:** a false `resolved` at 15 s for A, C0, C+ and D. B and held
  pass, because they track each agent.

## 10. Evidence

All paths are under
`probes/86/design/`.

- Harness: `judge/zz-judge.test.ts`. It runs unchanged on any tree. Set
  `J_TREE`, `J_OUT` and `J_CORPUS=orig|real`, plus `J_BATCH`, `J_EVID` and
  `J_DPLUS` for B and D. C's switches are `D86_DATING`, `D86_BUSY`,
  `D86_HOLD`, `D86_DECAY`, `D86_NOGRAFT` and `D86_SETTLE`. C+ is
  `D86_DATING=c0 D86_HOLD=1 D86_DECAY=1 D86_SETTLE=2000`.
- Cadence: 100 ms steps; a poll every 5 s that lands 300 ms later; a tick and
  a pulse every second.
- Raw results: `judge/out/*.jsonl`. Compare them with `judge/cmp.py`, and
  score them with `judge/tally.py`.
- C+ prototype: `judge/cplus.diff`, which is C's `minimal.diff` plus the
  grafts behind switches, against 07c3935. Main's suite with C+ switched on:
  1345 of 1349 pass (`observability.test.ts` excluded; it needs `dist/`). The
  4 failures are the ones C0 already has. Logs are in `judge/out/suite-*.log`.
- Designers' write-ups and diffs: `session-level.md`, `correlate.md`,
  `minimal.md` and `free.md`, each with its `.diff`.
- All judge worktrees (`/home/dev/astir-d86-judge-*`, `-judge2-*`) were
  removed. Nothing was committed.
