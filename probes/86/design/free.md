# #86 redesign — Candidate D ("free"): one dialog per session, believed only as far as it was seen

**Verdict.** Stop attributing. A Claude permission dialog is a fact about the session's
screen. The listing reports it per session, and so does the agent-less Notification.
So D keeps exactly one dialog record per session and carries it on the main agent's
row, which is where 07c3935 already puts the Notification. PermissionRequest only
dates that record and helps end it. It never decides whose block it is. No rule reads
another agent's claim to decide anything, and that is the join all four review
rounds broke on.

**Convergence, said plainly.** D is the issue's own next-step candidate (block at the
session level, date it from the ask, clear it from the listing). If B is that
candidate, D is B with four additions. Each one was measured on the probes to change
outcomes.

The first addition is what makes dating from the ask safe. A session-level design
that dates from the ask and counts the dwell as *elapsed* time inherits 96d3367's
false alerts exactly. Ablation A1 in §3 shows it: Esc at 3 s alerts in 4 of 10
phases, a long tool approved at 3 s in 4 of 10, and one approved at 5.5 s in 9 of 10.

The four additions:

1. **The PSH-16 dwell counts proven time, not elapsed time.** A Claude dialog ends
   silently: Esc fires no hook, and an approved long tool fires nothing until it
   finishes. So a block alerts only once evidence *after* the dwell shows the dialog
   still up: a poll that began then, or the Notification. This removes a false-alert
   class that 96d3367 introduced. For a long tool approved, or a dialog dismissed
   with Esc, between the first poll and 5 s, 96d3367 alerted in 4 of 10 poll phases,
   and in 9 of 10 at 5.5 s. D alerts in 0 of 10. F1 control, P2 and P3 are the same
   class.
2. **The Notification proves a 5 s dialog by itself.** Claude sends `permission_prompt`
   only after the dialog has been up about 6 s. The measurement was 5.76 s after it
   became visible. So a notice opens or extends the dialog dated `N − 5 s`. Without a
   listing (discovery down, a masked session, AskUserQuestion), the alert then lands
   at about 6.2 s instead of 11.2 s.
3. **An exact ask ledger, keyed by a digest of the call.** A PermissionRequest's
   `tool_input` is the PreToolUse's, unchanged, and PostToolUse carries it too. So
   `sha256(tool_name, stable(tool_input))`, held in memory only, ties each ask to the
   end of its own call with no heuristic. The dialog ends at once when the ledger
   empties: the call's own PostToolUse or failure, SubagentStop, or main's Stop.
   While another ask is still pending, the dialog continues. That gives continuity
   across parallel and queued dialogs without saying whose dialog is on screen.
4. **Optional confirming poll (D+).** When an unproven dialog reaches its dwell, the
   daemon asks `claude agents --json` once, right then. With the probes' 300 ms
   listing, a lone dialog then alerts 5.2 s after it appears in every poll phase,
   with or without a Notification.

   With a 1.2 s listing (also measured), D+ alerts at 6.2 s in every phase, the same
   as the Notification path. It still helps when there is no Notification (6.2–7.2 s
   against D's 6.2–11.2 s). So D+ is cheap insurance for a user who is typing at the
   terminal, not a headline number.

**Prototyped:** yes. The prototype runs the real Registry, NotifyLoop, NotifyPolicy
and Dispatcher on a fake clock. One harness
(`test/zz-free-score.test.ts`, inside `free.diff`) runs unchanged against 07c3935,
96d3367 and D. It replays every probes/86 timeline, the ten baselines and a 10-phase
poll sweep. Every cell below marked M was produced by that harness in this session.

---

## 1. Mechanism (exact rules)

These apply only to a provider that declares `sessionDialogs` (Claude:
`{ noticeAgeMs: 5000 }`). Codex declares `null` and keeps 07c3935 byte for byte
(CAP-02: the registry reads the capability and `DiscoveredSession.screen`, never a
provider's name).

**What blocks, and from when**

| # | Evidence | Effect |
|---|---|---|
| R1 | `PermissionRequest` (any agent) | Push an ask `{agentId, key = digest(tool_name, tool_input), at}` onto the session's ledger (cap 32). **No state change.** |
| R2 | A listing poll that **began** at P reads `permission-dialog` (`waiting` + `"permission prompt"`) | Open the session's dialog, or confirm it (`seenAt = max(seenAt, P)`). Date it from the newest ask with `0 ≤ P − at < 6 s`, else from P. |
| R3 | A `permission_prompt` notice arrives at N, whichever agent it names | Open or confirm the dialog, dated `N − noticeAgeMs`. While unannounced, `since = min(since, N − 5 s)`. |
| R4 | Opening | The main agent (agentId = sessionId) becomes `blocked / permission_prompt`, back-dated to `since` (96d3367's `transition(since)`). Its own state is stashed as `base`. |
| R5 | PSH-16 gate | For the main row while a dialog is open, `blockedForMs = max(seenAt − since, elapsed of a hook block underneath)`. The loop's dwell compares against that. Reminders are not gated, as before. |

**What clears**

| # | Evidence | Effect |
|---|---|---|
| E1 | A poll that began at P > `seenAt` reads `at-prompt` (`idle`) | The dialog ended (Esc, or the turn ended). Main goes to `waiting`. Asks made ≥ 1 s before P are dropped. |
| E2 | A poll that began at P reads `working` (`busy`), with an earlier poll in this dialog having read `waiting` (`waitSeenAt < P`) | The dialog was answered. Main goes back to `base`, with the tool name restored. A `busy` with no `waiting` before it is no evidence, because AskUserQuestion reads `busy` for its first seconds. |
| E3 | The ledger empties: a PostToolUse or failure whose digest matches an ask, SubagentStop (that agent's asks), or main's Stop / SessionStart / SessionEnd (all asks) | End now. If the event is main's, the ordinary 07c3935 path applies it. Otherwise main goes back to `base`. |
| E4 | Main's turn is over (Stop / SessionStart / SessionEnd) | End now. |
| E5 | **Fallback:** no informative listing reading (dialog, at-prompt or working) within 12 s, meaning discovery is down, the session is unlisted, or the session is masked by a queued elicitation | Main's own progress ends the dialog, which is 07c3935's rule exactly. |

**Underneath and around**

- **B1 (base).** While a dialog is open, the main agent's own events update `base`
  and leave its row blocked. A parallel call, or a dialog the listing will end, does
  not flap the alert. An `agent_needs_input` or `worker_permission_prompt` arriving
  then becomes a hook block under the dialog. When the dialog ends, main stays blocked
  for that reason, dated from its own arrival if nothing was announced yet. This is
  the F5 fix.
- **B2 (decay).** An agent with a pending ask is exempt from idle decay while its
  session's dialog is open. Only those agents: this is F4's skip narrowed to them.
- **Guards.**
  - G1: the listing is monotonic per session. A poll that began before one already
    folded in is dropped.
  - G2: evidence older than whatever ended the last dialog (`dialogClearedAt`) is
    ignored.
  - G3: E1's rule that the poll must be newer than `seenAt`.
- **Restore.** A restored `blocked / permission_prompt` main row recreates the dialog
  with `seenAt = restore time`, so the listing can confirm or end it. The loop's
  restore dwell still applies.
- **D+ (optional).** `registry.dialogCheckDue()` returns true once per dialog that
  has reached `since + dwell` unproven. The daemon's 1 s tick then calls
  `reconcile()` once.

**Who the alert names.** The session's main agent row. Focus is per session and pane
(PSH-11), so the alert takes you to the right pane. It never names the subagent that
asked. 07c3935 never did either.

**State.** All of it is per session and in memory, never persisted or on any
surface:

- `dialog {since, seenAt, waitSeenAt, base, checkAskedAt?}`
- `asks[]`
- `listingAt`
- `informativeAt`
- `dialogClearedAt`

D adds **no per-agent fields**. 96d3367 added three to every agent (`dialogSince`,
`dialogHeldAt`, `dialogSeenAt`).

Contract and adapter changes:

- an optional `callKey` (a 22-character base64url digest) on `AstirEvent`
- the Claude normalizer computes it for PreToolUse, PostToolUse, PostToolUseFailure
  and PermissionRequest
- `sessionDialogs` replaces 96d3367's `listingClearsBlocks`

D also keeps 96d3367's plumbing: PermissionRequest maps to `permission_request`,
plus `claudeScreen`, `pollInto` / `observedAt` and `blocksBegun`.

## 2. Scorecard

The columns are main = 07c3935, 86 = 96d3367, D, and D+ = D with the confirming
poll.

- **M**: measured by the cross-version harness. 100 ms steps; a poll begins every 5 s
  and lands 300 ms later; tick and pulse every 1 s; Claude's dwell is 5 s.
- **R3**: also reported by round 3 in probes/86/README, and consistent with M unless
  noted.

Times are seconds on the timeline. "+x" means seconds after the event named in the
row. The probes' own hook times are used unchanged.

**One caveat on the ledger in these rows.** The ported probes reuse one `tool_input`
for main, SUB and BG, and they model a re-claim as an identical PermissionRequest. So
in S1, S1-control, S2c, S3, S8, R1, (v) and (viii-d) every ask shares one digest, and
the ledger behaves as first-in-first-out by key. I therefore re-ran S1, S1-control,
S2c, S3 (both), S8 and R1 (background acts at 8 s) with a distinct input per call,
each call's own PostToolUse, and main's B ending at 90.1 in S1. D's stories are
identical (M):

- S1: 10, 70, 95
- S1-control: 10, 65
- S2c: 8 … 368, blocked
- S3: 7, 32
- S8: 7, 41
- R1: 7, 63

96d3367's are also identical to its shared-input stories. (vii) used distinct inputs
from the start.

**Slower listing (M, landing 1.2 s instead of 0.3 s):**

- (i) with a Notification: D 6.2 in all phases, D+ 6.2 in all, 96d3367 5.2–6.2.
- (i) without a Notification: D 6.2–11.2, D+ 6.2–7.2, 96d3367 5.2–6.2.
- False alerts on D and D+ stay at 0/10 for (ii) Esc at 3 s and (iii-c).
- R6 on D: 0 lost, 0 background alerts, 0 early resolved.

### Baselines (measured fact: PreToolUse 0, PermissionRequest 0.41, dialog visible 0.82, Notification 6.58)

| Case | main | 96d3367 | D | D+ | |
|---|---|---|---|---|---|
| (i) lone Bash dialog: alert after visible, over 10 poll phases | 11.2 in all | 5.2 in all | 6.2 (5.2 in 1 phase) | **5.2 in all** | M |
| (i) the same, with no Notification (user typing at the terminal) | never | 5.2 | 5.2–10.2 by phase | **5.2 in all** | M |
| (ii) Esc at 20 s: resolved after Esc | never; reminds every minute | +1–5 (one poll) | +1–5 | +1–5 | M |
| (ii) Esc at 3 s, inside the dwell: alerts sent | 0/10 | **4/10 (false)** | 0/10 | 0/10 | M |
| (iii-a) approve at 20 s, quick tool | +1.0 | +1.0 | +1.0 | +1.0 | M |
| (iii-b) approve at 20 s, tool runs to 120 s | +100 (blocked while the tool runs) | +1–5 | +1–5 | +1–5 | M |
| (iii-c) approve at 3 s, long tool: alerts | 0/10 | **4/10 (false)** | 0/10 | 0/10 | M |
| (iii-e) approve at 5.5 s (after the dwell), long tool: alerts | 0/10 | 9/10 | 0/10 | 9/10 (the dialog really lasted past the dwell) | M |
| (iii-f) poll began 20.0, approval 20.05, Post 20.15, poll lands 20.3 | resolved 21 | resolved 21 | resolved 21 | resolved 21 | M |
| (iv) auto-mode approval (no PermissionRequest, no Notification) | 0 | 0 | 0 | 0 | M |
| (v) subagent's dialog: alerts (who) / resolved after approval at 30 | 1 (main) / +11 (until the subagent finishes) | 1 (subagent) / +1 | 1 (main) / +1 | 1 (main) / +1 | M |
| (v-b) the same, with no `agent_id` on the PermissionRequest | 1 (main) / +11 | 1 (main) / +1–5 | 1 (main) / +1 | 1 (main) / +1 | M |
| (vi-a) background ask Claude denies itself, alone | 0 | 0 | 0 | 0 | M |
| (vi-b) self-denied ask −2/+1/+3 s around main's real dialog: main alert / background alerts / resolved while up | 11.2 / 0 / 0 | 5.2–6.2 / 0 / 0 | 5.2–6.2 / 0 / 0 | 5.2–6.2 / 0 / 0 | M |
| R6 sweep (120 runs of the same) | never alerted 0/120; background 0; early resolved 0; mean 12.0 | 0/120; **background 20; early resolved 20; max 26 s** | 0/120; 0; 0; mean 7.0, max 7 | 0/120; 0; 0; mean 6.4, max 7 | M (R3 reported the 96d3367 losses) |
| (vii) parallel asks A,B (A up 0.8–20, B 20–40) | blocked 12, res 21, blocked 32, res 41 | blocked 6, res 21, blocked 32, res 41 | **blocked 7, res 41** (one block) | blocked 6, res 41 | M |
| (viii-a) discovery down, approve at 20 | blocked 12, res 21 | 7, 21 | 7, 21 | 7, 21 | M |
| (viii-b) discovery down, Esc, nothing after | stuck, reminding | stuck | stuck (= main) | stuck | M |
| (viii-c) discovery down, Esc, next turn's PreToolUse at 45 | res 45 | res 45 | res 45 | res 45 | M |
| (viii-d) discovery down, subagent approved at 30, subagent runs to 90 | 13 / 73 reminder / res 91 | sub 8 / res 31 | 8 / res 31 | 8 / res 31 | M |
| (ix) session whose hooks reach this daemon but no local listing reports it | 12 / 21 | 7 / 21 | 7 / 21 | 7 / 21 | M |
| (ix) remote host running its own daemon | that daemon's own listing: identical to local | same | same | same | argued: DMN-09 SSH rows (`RemoteDiscovery`) never enter `reconcile` |
| (x-a) Codex Esc (Interrupt) at 5.9 s | none | none | none | none | M |
| (x-b) Codex Esc at 45 s | 32 / res 45 | same | same | same | M |
| (x-c) = S4c Codex sibling at 16 min | idle | **thinking** | idle | idle | M (R3) |
| AskUserQuestion answered at 20 / Esc at 20 | 11.2 / res +1 / **never** | 6.2 / +1 / +1–5 | 6.2 / +1 / +1–5 | 6.2 / +1 / +1–5 | M |
| AskUserQuestion answered at 4 s: alerts | 0 | 0 | 0 | 0 | M |

### probes/86 timelines

| Probe | main | 96d3367 | D | D+ | |
|---|---|---|---|---|---|
| **S1 / F1** (parallel re-claim while A is up) | blocked 15, res 61, blocked 72 | blocked 8, **sub 10, false res main 10**, sub 70, res sub 95 | blocked 10, reminder 70, res 95; no subagent alert, no early resolved | 9, 69, 95 | M (R3) |
| S1-control | 15 / res 61 | 8 / 61 | 10 / 65 | 9 / 65 | M |
| **S2 / F2** dead=false | 12, res 21, 32, … main blocked | 6, 21, 32, … blocked | 7, reminders 67 and 127, blocked at 180 | 6, … | M (R3) |
| **S2 / F2 / F3** dead=true | same as dead=false | **6, res 21, SUB2 22, res SUB2 45, main idle** | 7, 67, 127, blocked at 180; SUB2 never alerted | 6, … | M (R3) |
| S2b (approved tool, then a dialog with no ask) | nothing | 5, res 21; **plan dialog never alerted** | 7, res 22, **blocked 32** | 6, 22, 32 | M |
| **S2c / F2** | 13, res 61, 72 … 372, blocked | 7, res 61, **subagent alerted from 66, main idle at 400** | 8, reminders to 368, blocked at 400; no subagent alert | 7, … | M (R3) |
| S3, subagent's Notification true/false | 16 / res 64 ; nothing | main 5, **sub 11**, res 31, res 32 ; 5 / 32 | 7 / res 32 (both) | 6 / 32 | M |
| S8 | 12 / res 21 | sub 6 / 41 | 7 / res 41 (one block across two queued dialogs) | 6 / 41 | M |
| **S4 / F4** (subagent with no SubagentStop, sibling's dialog up 10–600) | SUB idle, active 36.9 s | **SUB thinking, banks 610 s at the end** | SUB idle, active 36.9 s; SUB2 tool-running (asking, exempt) | same | M (R3) |
| S4b (agent_needs_input on main, Esc, 1 h) | main blocked, SUB idle | **SUB thinking** | main blocked, SUB idle | same | M (R3) |
| **S5 / F5** (agent_needs_input during an unannounced block, Esc) | 8, 68 (needs-input alerted) | **[] never alerted** | 8, 68, main blocked/agent_needs_input | same | M (R3) |
| S5b | blocked / permission_prompt at the end | waiting, [] | back to blocked / agent_needs_input, alerted 11 | same | M |
| S6a (discovery down) | 12 | 7 | 7 (dated 1.4 = N − 5) | 7 | M |
| S6b / S6c (Notification owner) | main / main | main / **subagent** | main / main | main | M |
| S6d (masked by "input needed") | 12, res 30, 41 | 7, 30, 41 | 7, res 30, **36** | 7, 30, 36 | M |
| **S7 / VR3-86-5 / F6** (blocksBegun around a retraction) | n/a | 1→**2** (counts a retracted block) | 1→1 (nothing to retract) | 1→1 | M (R3) |
| **RY / VR3-86-1** | nothing | 6, **sub 7, false res main 7** | 6, main blocked | 6 | M (R3) |
| **RX / VR3-86-2** | 5 | 5, **sub 13, false res main 13** | 1 (the notice proves 5 s), main blocked | 1 | M (R3) |
| DOCS lone young claim / VR3-86-3 | main blocked | main blocked (docs said otherwise) | main blocked: this is D's rule, not an exception | same | M |
| VR3-86-4 / F7 (mutation gaps) | — | 7/33 and 11/25 survivors | replaced by the ablation in §3: 11 of 14 rule ablations change the scorecard | — | M |
| VR3-86-6 / F3 (CHANGELOG wording) | — | doc-false | n/a: D's docs would be written from §1 | — | — |
| R1 (self-denied ask newer than main's, background acts at 3/5/8/15/40) | 12 / 60 | 7 / 60 for 3,5; **background alerted at 6 then main late (13/18/45)** for 8/15/40 | 7 / res 63 for all | 7 / 63 | M (R3) |
| R2 | 12 / 60 | 5 / 60 | 7 / res 62 | 6 / 62 | M |
| R3 (parent with a subagent's dialog) | main 13, 73; **no resolved, main blocked** | sub 7, 67, res 91 | main 8, 68, res 91; parent and subagent stay tool-running | 7, 67, 91 | M |
| R4 (needs-input then Esc) | 11, 71, 131, 191 needs-input | 5, **res 7** (needs-input lost) | 11, 71, 131, 191 needs-input | 6, 66, … | M |
| R5 (claimless dialog shown at 6/9/12/30 s, stale ask at 0) | nothing | 7 (dated from the stale ask, 1 s in) / nothing / nothing / nothing | 12 / 17 / 22 / 37 (about 6 s after it shows) | same | M |
| F1 variants (verify): control, P2, P3 | [] | **false alert at 5, res 7** | [] | [] | M (R3) |
| F1 P4 (subagent's dialog up 6–21) | [] | 5 / res 22 | 7 / res 22 | 6 / 22 | M |
| M19c (Esc, then a dialog with no ask 2 s later) | tool-running | waiting (**never blocks it**) | blocked, unannounced (needs proof) | same | M |
| M33c (notice block, re-ask, then a busy reading) | blocked | blocked | thinking: busy after waiting means nothing is on screen | same | M |
| F3busy (non-blocking notices after a sighting, then busy) | tool-running | tool-running | tool-running | same | M |
| F4 (FileChanged at 0.5–30 s) | blocked 15 | blocked 5 | blocked 10 (a harness artifact: it pulses only at 5, then from 10; a live daemon pulses every second and would alert at 7). FileChanged never ends the dialog. | same | M |
| Daemon restart with a dialog up (restore) | proven by the loop's restore dwell | same | the dialog is recreated with `seenAt = restore` | same | **not measured** |
| Stale listing lands after a newer one | idle | waiting | waiting | same | M |
| Two sessions, one dialog each | nothing | A 5, B 6, res B 11 | A 6, B 6, res B 11 | same | M |

## 3. Ablation: is every rule load-bearing? (measured)

Each rule was disabled in turn, the scorecard re-run, and the changed lines counted
(`ablation-1.txt`, `ablation-2.txt` and `ablation-confirm.txt` beside this file).

| Rule disabled | Scorecard lines that change | Example |
|---|---|---|
| R5 proof (dwell from `since` to now) | 43 | (ii) Esc at 3 s → 4/10 false alerts; (iii-c) → 4/10; (iii-e) → 9/10 |
| R3 notice back-dating (age 0) | 13 | every discovery-down, AskUserQuestion and (v-b) alert lost: proof never accrues |
| R2 ask dating (date from the poll) | 5 (28 with D+) | D+ latency goes back to 5.2–10.2 s without a Notification |
| E3 ledger-empty end | 9 | approvals clear in +1–5 instead of +1; (v-b) discovery down resolves at 41 instead of 31 |
| E5 fallback own-progress | 2 | (viii-c) never resolves; S6d's queued dialog is never alerted |
| E2 "waiting before working" | 2 | AskUserQuestion in one phase: alert lost entirely |
| B1 base shadowing (main's progress always ends it, as in 07c3935) | 16 | S1, S2, S2c, S8 and (vii) get resolved and re-alerted mid-dialog |
| B1 needs-input kept under the dialog | 3 | S5, S5b, R4: needs-input never alerted (F5 is back) |
| B2 decay exemption | 2 | S4 SUB2 and R3 subagent read idle with the dialog up |
| Ask window 60 s instead of 6 s | 5 | R5 and S2b alert 1 s into a claimless dialog |
| G2 cleared-at guard | 1 | (iii-f) final state only: proof gating absorbs the spurious reopen |
| G1 monotonic listing, G3 at-prompt-newer-than-seenAt (both together) | 0 | **defensive only.** No reachable timeline in this model needs them; they are one line each. |

## 4. Risks

0. **The 5000/5000 boundary is what makes a notice-only block alert.** Proof is
   `N − (N − noticeAgeMs) = 5000`, and the loop's gate is `blockedForMs < dwell`, so
   equality is doing the work. If `noticeAgeMs < blockDwellMs`, every alert that has
   no listing behind it is lost: discovery down, AskUserQuestion, masked sessions,
   (v-b). Ablation A2 with age 0 measured exactly that. Declare
   `noticeAgeMs >= blockDwellMs` as an invariant of `sessionDialogs` and test the
   exact boundary. The prototype has no such test; it is the kind of survivor F7
   complained about.
1. **`noticeAgeMs = 5 s` trusts Claude's Notification timing.** It was read from
   2.1.312 (the notice is sent after 6 s idle at the dialog) and measured at 5.76 s
   after the dialog became visible. If Claude ever sends `permission_prompt` sooner,
   or for an ask its classifier answered, D alerts at once with no dwell. Pin it with
   the fixture, and re-measure on each Claude bump.
2. **The ledger depends on PostToolUse carrying the same `tool_input` as the
   PermissionRequest.** A PreToolUse hook that rewrites input (`updatedInput`)
   leaves the ask pending. Fast clearing is then off for that session until the turn
   ends, and the listing still ends the dialog within one poll. Two identical calls in
   flight can resolve each other's asks. The worst case is an early end, a re-sighting
   within 5 s, and, if it was announced, a `resolved` followed by a re-alert.
3. **Asks Claude denies itself linger** until SubagentStop or the end of the turn.
   While one lingers, an approval clears within one poll instead of at once. Measured:
   S1-control +4 s and R1 +3 s against 96d3367.
4. **A dialog with no ask** (plan approval and similar) that is up while the ledger
   empties is ended early, then re-seen at the next poll. It is never lost; if it had
   been announced, that costs a `resolved` and a later re-alert.
5. **Masked sessions** (an elicitation queued forever reads `waiting` / `"input
   needed"`). The listing never sees or ends anything there, so D falls back to
   07c3935 plus the Notification. Esc then sticks until the next event, as on main.
6. **The vocabulary was read from the binary.** `"permission prompt"` for dialogs with
   no ask, `busy` never shown while a dialog that already read `waiting` is still up:
   measured for Bash and AskUserQuestion only. If the label changes, D degrades to the
   discovery-down behaviour (alert at about 6.2 s via the Notification, no Esc
   clearing), never to a false alert.
7. **PSH-16 wording.** "Has lasted the dwell" becomes "was still seen after the dwell"
   for providers whose dialogs end silently. The spec should say so. I have not
   edited it.
8. **Existing tests change by design.** 11 tests model "a Claude permission_prompt
   Notification starts a block that then waits 5 s": announced.test 5,
   notify-loop.test 3 (PSH-16), and registry.test 3 (G4 turn time, because of
   back-dating). They need re-pointing at Codex or at a sighting.
   test/claude-permission.test.ts (96d3367's) is replaced wholesale.
   observability.test's 3 failures are environmental: they need `dist/` and fail on
   main too.
9. **D+ adds one `claude agents --json` spawn per unproven dialog.** `reconcile()`
   has no overlap guard; G1 makes overlap safe, but each spawn costs CPU.
10. **Whether a subagent's PermissionRequest carries `agent_id` is not measured.**
    D's key leaves the agent out, so D does not depend on it; (v-b) measured.
11. **A block the listing begins returns no `becameBlocked`.** Only one that a hook
    begins does. The daemon's `onBlocked` option is not wired in `src/cli/main.ts`,
    and the counter is `blocksBegun()`, so nothing is lost today. A future consumer
    of `onBlocked` would miss blocks the listing begins (96d3367 had the same gap).

## 5. User-visible trade-offs

- **The alert names the session's main agent, never the subagent that asked.** Same
  as main; 96d3367 named the subagent when its attribution held. Clicking still
  lands in the right pane, since focus is per session.
- **Back-to-back dialogs are one block.** This covers parallel asks and a subagent's
  dialog queued behind another, as long as there is no gap. You get one alert, then
  the every-minute PSH-02 reminders, not a fresh alert per dialog. An acknowledgement
  carries over to the next queued dialog. You will have just answered the previous
  one at the terminal.
- **Alert timing.** About 6.2 s after a dialog appears (D), or 5.2 s with the
  confirming poll (D+) when the listing answers in 0.3 s. With a 1.2 s listing both
  are 6.2 s. That compares with 11.2 s on main and 5.2–6.2 s on 96d3367.
- **A prompt answered or dismissed within ~5 s never alerts**, even when the
  approved tool runs for minutes. 96d3367 alerted in up to 9 of 10 phases.
- **Clearing.** Esc clears within one poll (1–5 s). An approval clears at once when
  no other ask is pending, otherwise within one poll. A subagent's approval also
  clears the main row at once; main kept it blocked until the subagent finished.
- **Discovery down.** The alert comes at about 6.2 s instead of 11.2. Esc still
  sticks until the next event, as on main.
- **Dialogs with no ask** that the listing reports as "permission prompt" (plan
  approval and similar) now alert about 6 s after they appear. Neither main nor
  96d3367 alerted them from the listing.
- **Waiting time reads 5 s longer** on a notice-opened block ("blocked since" is
  dated `N − 5 s`), and G4 banks those 5 s as blocked.
- **A subagent waiting on its dialog no longer drops to idle**, but its time still
  banks as working (G4), as on main. Only the main row banks blocked time.

## 6. Complexity

- **registry.ts.** D adds 446 lines over 07c3935, about 296 of them code (not comment
  or blank), including the D+ check and the carrier helper. 96d3367 added
  +543/−29, about 210 lines of code. **D is not smaller in code.**
- **State.** D has 5 session fields and 0 agent fields. 96d3367 had 3 agent fields,
  checked across every agent in the session.
- **Rules.** D has R1–R5, E1–E5, B1, B2, three guards, restore and D+. Every rule is
  a predicate on one session record. None compares claims across agents, and the
  ablation shows which rules carry weight.
- **Other files.** `normalize.ts` gains a call digest (+30 lines), `event.ts` an
  optional `callKey` (+13), `capabilities.ts` `sessionDialogs` (+20), and
  `main.ts` one line for D+. `discovery/sessions.ts` and `daemon/server.ts` are kept
  from 96d3367. `notify/loop.ts` is unchanged from main.

## 7. Reproduce

- **Worktrees** (throwaway, removed after the run; rebuild them from `free.diff` on 07c3935, or on 280b316 for the fixtures): `/home/dev/astir-d86-free` (D, base 280b316),
  `/home/dev/astir-d86-free-main` (07c3935) and `/home/dev/astir-d86-free-86`
  (280b316 = 96d3367 and the probes).
- **Scorecard:** `SCORE_TAG=x SCORE_LOG=… [SCORE_CONFIRM=1] npx vitest run
  test/zz-free-score.test.ts` in any of the three, with `SCORE_LAND=1200` for a
  slow listing. Logs are `score-free-main.log`, `score-free-86.log`,
  `score-free.log`, `score-free-confirm.log` and the `*-land1200.log` files in
  this directory. The harness source is `score.test.ts`.
- **Ablation:**
  `/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/86-redesign-tools/ablate.py`.
- **Prototype diff against 07c3935:** `free.diff`.
