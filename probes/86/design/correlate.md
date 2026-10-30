# #86 redesign, candidate B: correlate the claim to its agent (the dialog queue)

Designer: candidate B on the #86 panel. Prototype built, and every probe timeline replayed through the real
`Registry` and `NotifyLoop` on a fake clock, on three trees: main 07c3935, held 96d3367, and this candidate.
Diff: `correlate.diff` (next to this file). Harness and raw results: `correlate-evidence/`.

## TL;DR

Treat a session's `PermissionRequest`s as a model of Claude's own dialog queue, and stop guessing between
claims:

1. **Exact claims.** Each `PermissionRequest` is tied, in memory, to the `PreToolUse` it follows
   (same session, tool and hash of `tool_input`, and the agent when the payload names one). That gives the
   claim a `tool_use_id` and an agent.
2. **One queue per session, FIFO.** Claude shows tool dialogs one at a time, oldest ask on top. That was
   read from the 2.1.312 binary, and the probes and 96d3367 assume it too. The queue's head is what the
   listing's "permission prompt" and the agent-less Notification refer to. Only the head's agent can be
   permission-blocked, so one dialog blocks one agent.
3. **Exact exits.** An ask leaves the queue on its own `PostToolUse`/`PostToolUseFailure` (matched by
   `tool_use_id`), on `PostToolBatch` (a new hook, which also closes asks that Claude denied itself), on
   its agent's `Stop`/`SubagentStop`, or on a listing reading with no dialog on screen.
4. **Two signals settle what is on screen:**
   - A listing sighting blocks the head's agent, unless the head might have been answered unseen while
     another agent's ask waits behind it. That case is ambiguous, and the sighting defers to the
     Notification.
   - The Notification goes to the first ask in queue order whose timing fits Claude's 6-second check
     grid. Asks ahead of it leave the queue (FIFO says they are not pending).

**Measured.** Every README finding (VR3-86-1..6, F1..F7), all the R1-R6 / S1-S8 timelines, and the 10
baselines replay with no lost alert and no false `resolved`. There is no retraction, so VR3-86-1/2 and F6 cannot arise. F1, F2, F3,
F4 and F5 are fixed. The R6 sweep is 0/120 bad (96d3367: 20/120 background-agent alerts and 20/120 false
resolves). A lone Bash dialog alerts 6 s after PreToolUse (~5.2 s after it appears; main: 12 s).

**Residuals, measured.** None loses an alert. Residuals 1 and 2 are a wrong agent name inside the right
session. Residual 3 is a false alert, shared with 96d3367, that the recommended `evidenceDwell` option
removes.
- Without `PostToolBatch`, a self-denied ask raised ≤0.5 s before another agent's real one names the
  wrong agent (R1-rev: 20/60).
- A first dialog answered within ~1-3 s, while its tool runs on and another agent's dialog is queued
  right behind it, is named after the first agent until the Notification corrects it (14/70 in the
  close-claims sweep).
- An early answer (2-4.5 s) can still alert once. 96d3367 does the same (15/30). An `evidenceDwell`
  option removes it (0/30) for about 1 s more latency.

## What this design stands on

Read from the Claude Code 2.1.312 binary (`~/.local/share/claude/versions/2.1.312`, static read only):

| Fact | Where (minified names) | Status |
|---|---|---|
| Tool dialogs show one at a time. The dialog on screen is `open.findLast(e => !e.userInvoked)`. A tool ask is inserted with `place: "queue"` by `askOrder` (a per-host counter taken when the ask is raised), which keeps the oldest ask on top. So it is FIFO. | dialog store `ydo()`/`NE()`/`h()`; ask site `Le()`: `place: Qe ? "under" : bo ? undefined : "queue", askOrder: ko` | binary-read |
| Exceptions to FIFO: (a) a teammate's, an async agent's, or a person-only ask goes `"under"`, at the bottom when it is shown. (b) An ask with an auto-deny timer (auto mode's denial-limit fallback or a timed safety check, `ve = autoDenyAfterMs`) is appended on top. (c) Non-tool dialogs (plan approval and so on) use their own placement and may go on top. | `lEn()`, `bo = !Qe && ve !== void 0` | binary-read |
| A self-denied ask (`shouldAvoidPermissionPrompts`) runs the PermissionRequest hooks and is then denied (`decisionReason.type: "asyncAgent"`). It never enters the dialog store. No PermissionDenied hook fires: that hook fires only for auto-mode classifier denials. | `cEe()`, `yIo()` call site | binary-read |
| `PostToolBatch` fires after every completed batch with `tool_calls[{tool_name, tool_input, tool_use_id, tool_response}]` for every tool_use in the message, denied ones included. It is skipped when the turn is aborted (Esc). | `zVn()` call sites after `if (aborted) return` | binary-read, **not captured live** |
| The `permission_prompt` Notification comes from the dialog component's hook. It checks every 6 s from mount and sends **once**, at the first check where the user has been idle ≥6 s (`now - max(lastInteraction, mount) >= 6000`). So it arrives at mount + 6k s. | `wMe()`, `Sun=6000` | binary-read; consistent with the measured 6.17-6.58 s after PermissionRequest |
| PermissionRequest's base input is `lf(session, cwd, mode, toolUseContext)`, so it carries `agent_id` for a subagent. The Notification is `lf(e, Ug())` with no context, so no agent. | `lf()`, `PGe()` | binary-read. The fixture (main agent) has none, and the brief says none. The design works either way (measured both). |
| The listing's `waitingFor` is derived from the pending action's tool: AskUserQuestion and `dialog:*` read `"input needed"`, every other tool `"permission prompt"`. | `UO()` | binary-read |
| Sidecars carry `requestShape` (`foreground`/`background`) and `requestNonInteractive`. | sidecar writer `f$t()`; key names seen in 173 local sidecars, all `foreground` | binary-read; key names measured |

Measured facts used (from the brief): PermissionRequest ~0.4 s after PreToolUse, dialog visible ~0.8 s,
Notification 6.2-6.6 s after PermissionRequest, Esc fires no hook, auto mode fires no PermissionRequest,
AskUserQuestion reads `busy` at ~1 s then `input needed` by ~8 s, the listing reads `waiting`/"permission
prompt" at the first poll, `idle` after Esc, `busy` while working.

## Mechanism: exact rules

**Scope.** Everything below applies to a provider that declares the new capability `dialogQueue`. Claude
does; Codex does not. Codex's path is main's, byte for byte (CAP-02: the registry reads the capability,
never the provider name).

**R0. Correlation (adapter, in memory).**
- `PreToolUse` records `{callId: tool_use_id, agent, tool, digest}` in a per-daemon `ClaudeCallCorrelator`.
  `digest = sha256(stable JSON of tool_input)`, truncated, kept only in memory.
- `PermissionRequest` claims the oldest open, unclaimed call with the same session, tool and digest. If
  the payload names an `agent_id`, only that agent's calls are candidates. If it names none, the main
  agent's calls are preferred, then any agent's.
- If no digest matches (a PreToolUse hook rewrote the input), the fallback is the same agent and tool,
  oldest first.
- The event then carries `callId` and the correlated `agentId`.
- `PostToolUse`, `PostToolUseFailure` and `PostToolBatch` close calls. `Stop`/`SubagentStop` close that
  agent's calls. `SessionEnd` drops the session.
- Bounds: 256 open calls per session, 512 sessions. Nothing here is persisted or logged (SEC-01).

**R1. Claim.** A `permission_request` appends an ask
`{callId, agentId, kind: question if AskUserQuestion else permission, claimAt: now}` to the session's
queue. It changes nothing else: the agent is still running its tool, as far as anyone has seen.
- `soloAtClaim` is true when the queue was empty at the claim.
- `headSince` is the claim time for a solo ask.

**R2. Exact exits.** An exact exit removes the ask:
- its own `post_tool`/`tool_failed` (by `callId`);
- `tool_batch` (every `callId` it lists);
- its agent's `stop`/`subagent_stop`;
- `session_start`/`session_end`, which clear the queue.

When the head leaves through an exact exit and that head was on screen (`seen`), the next ask is
**in line**: Claude shows the next queued dialog once one is answered. If the next ask is the same
agent's, it inherits `seen` and the block continues without a transition (parallel asks: one alert).

**R3. Who is blocked.** An agent is permission-blocked if and only if it owns the head and the head is
`seen`. One dialog blocks at most one agent. The block is dated from `head.since`:
- a listing sighting: `max(claimAt, headSince)`;
- the Notification: `max(claimAt, min(headSince, N − 6.2 s))`.

`headSince` is the time an ask became head behind a head that was on screen, or its own claim when the
ask ahead was never seen.

**R4. Listing sighting.** A poll begun at `T` reads `permission-dialog` (permission prompt) or
`question-dialog` (input needed). The head matches when its kind matches the reading and
`head.claimAt ≤ T`. A mismatch is no evidence (a claimless dialog, or a masking elicitation).
- If every ask claimed by `T` belongs to the head's agent, or the head is in line, or the head is fresh
  (`T − headSince ≤ 1.5 s`, too soon to have been answered), the head becomes `seen`.
- Otherwise the reading is **ambiguous**. The head may have been answered unseen (its tool still running,
  with no hook to say so) while another agent's dialog is on screen. The block is deferred to the
  Notification.
- If the ambiguity persists 13 s (past the second 6 s check, for a user who touched the terminal), the
  FIFO head takes it.

**R5. Notification.** A `permission_prompt` with no agent lands on the main agent by default. It goes to
the **first ask in queue order that fits**.
- An ask fits if it has not already had a Notification (one per dialog mount), is ≥5 s old, and:
  - if it is **solo at claim**, `N − claimAt` is in `[6k − 0.1, 6k + 0.9]` s (its dialog opened at its
    claim; the measured value is 6.17-6.58 s);
  - if it is **queued**, any time fits (its dialog opened whenever the one ahead was answered).
- Every ask ahead of the winner leaves the queue. Under FIFO it would be on screen if it were still
  pending, so it was answered and its tool is running.
- If no ask fits, the dialog sent no claim (plan approval and the like) or jumped the queue. The
  Notification then blocks the main agent as on main (a **notice**, R7).

**R6. Listing with no dialog.** A poll begun at `T`:
- reading `at-prompt` (idle) removes every ask claimed ≤ `T − 1 s` (Esc aborts the turn and every queued
  dialog with it); blocked agents go to `waiting`;
- reading `working` (busy) removes every ask claimed ≤ `T − 1 s`, unless the head is an unseen
  AskUserQuestion younger than 10 s (its listing lags); blocked agents go to `tool-running`.

This also retires asks that were approved unseen and whose tools still run (ghosts), and asks Claude
denied itself, whenever a poll falls in a gap.

**R7. Notices.**
- A blocking Notification no ask explains is a *notice* on the agent it landed on, dated from its
  arrival, exactly as on main: `agent_needs_input`, `worker_permission_prompt`, or a `permission_prompt`
  that R5 gave to no ask. It is never dropped (F5).
- The agent's own progress (`pre_tool`, `post_tool`, `tool_failed`, `stop`, `subagent_stop`,
  `session_*`) ends a notice. `file_changed`, `subagent_start` and other notifications do not.
- A `permission_prompt` notice also ends on `at-prompt`, or on `working` after a poll during it saw a
  dialog.
- Blocked = dialog part or notice part. The reason shown is `permission_prompt` while the agent holds the
  head.

**R8. What does not end a dialog block.** The agent's own events for other calls, such as a sibling's
`pre_tool` or `post_tool` in a parallel batch, and `file_changed` or other notifications. Only the head's
own exit, the agent's turn end, or the listing ends it. This is the F1/F2 fix.

**R9. Idle decay (F4).**
- Main's `tick()` is unchanged, plus one exemption: while the session's listing reads `waiting`, an agent
  with an open call (a PreToolUse with no exit) does not decay. That covers the parent running the Agent
  tool and an agent whose call waits behind a dialog.
- Nothing else is exempt: a subagent that went quiet with no open call decays at 30 s, as on main.

**R10. Dwell.** PSH-16 is unchanged: Claude 5 s, Codex 30 s, measured from the block's start (`since`).
- **Option `evidenceDwell`:** a dialog block reports `blockedForMs` as
  `latest evidence (sighting poll start or Notification) − since`. The first alert then waits for
  evidence that the dialog outlived the dwell. This removes the early-answer alert at ~+1 s median
  latency.
- **Recommended:** on. It is closer to PSH-16's "a block must prove it is real", and the Notification
  caps the latency at ~7 s for an idle user.

**Hooks.** `PermissionRequest` (as in 96d3367) and the new `PostToolBatch` (http, same shape). The reply is
`{ok, applied}` and carries no decision (NG4).

## State

All in memory. Never persisted (DMN-06 snapshot fields are unchanged) and never on a surface.

| Where | Field | Notes |
|---|---|---|
| daemon (adapter) | `ClaudeCallCorrelator`: per session, open calls `{callId, agentId, tool, digest, seq, claimed}` | bounded 256/session, 512 sessions |
| `SessionRecord` | `asks: Ask[]` | `{callId, agentId, kind, claimAt, soloAtClaim, headSince, inLine, seen, since, noticed}`, ≤64 |
| `SessionRecord` | `ambiguousSince` | one timestamp |
| `AgentRecord` | `noticeSince`, `noticeReason`, `noticeSeenAt` | the R7 notice part |
| `AgentRecord` | `openCalls: Set<callId>` | R9 |
| `AgentRecord` | `evidenceAt` | R10 option |
| `AstirEvent` | `callId?`, `callIds?` (tool_batch), `dialog?` (permission/question); new kind `tool_batch` | contract minor bump |
| `capabilities` | `dialogQueue` | claude true, codex false |
| `SessionScreen` | `question-dialog` (for "input needed") | added to 96d3367's translation |

Size (code lines without comments or blank lines):
- registry: +284 against main; 96d3367's registry was +210.
- all of `src/`: +479 against main, of which 424 are B's own on top of 96d3367's plumbing; 96d3367's was
  +260.
- `git diff --numstat` registry: +428/−7 (96d3367: +543/−29), plus `correlate.ts` (121 lines), normalizer
  +74, event +43, `hooks.json` +17.

So B is larger than 96d3367, mostly in the adapter and contract. Its registry rules are fewer and none
attributes by heuristic order alone: every attribution is either exact (by id) or follows from FIFO plus
one timing fact.

## Scorecard

How to read it:
- `B:x@t` means a `blocked` alert for agent x at second t; `R:x@t` means `resolved`.
- "M" means measured by replaying through the real Registry and NotifyLoop (1 s tick+pulse, polls every
  5 s landing 300 ms after they start, as in the daemon). "R" means reasoned.
- Unless noted, results are for the realized timelines: every ask has its own PreToolUse and
  `tool_use_id`, and a self-denied ask's batch ends with PostToolBatch.
- The harness was validated first: the original probe timelines reproduce the README's quoted stories
  exactly on main and 96d3367 (S1, S1-control, S2 dead=true/false, S2c, RY, RX).
- Candidate results hold with and without `agent_id` on PermissionRequest unless a row says otherwise.

### Baselines

| Case | main 07c3935 | 96d3367 | B | |
|---|---|---|---|---|
| (i) lone main Bash dialog, alert time after PreToolUse (dialog at 0.8 s) | 12 s (Notification 6.8 + dwell) | 6 s | **6 s** (5.2 s after it appears); 7 s with evidenceDwell | M, phases 0-4 s |
| (i) user typing (Notification on the 12 s check) | 18 s | 6 s | 6 s; 8 s with evidenceDwell | M |
| (ii) Esc at 20 s | never clears (blocked, reminders) | R@21/23/25 by phase | **R@21/23/25**: within one poll | M |
| (ii) Esc at a subagent's dialog, main carries on (busy) | names main; R@21 | B:SUB@6 R:SUB@21 | **B:SUB@6 R:SUB@21** | M |
| (iii) approve, quick tool | R@21 (PostToolUse) | R@21 | **R@21** | M |
| (iii) approve, long tool | stays blocked until the PostToolUse at 200 s | R@22 (busy poll) | **R@22** | M |
| (iv) auto-mode approval | none | none | **none** (no PermissionRequest, so no ask) | M |
| (v) subagent dialog: alert once, for SUB, parent not idle | B:main@12, names main | B:SUB@6 (main if no agent_id) | **B:SUB@6** in both agent_id modes; main stays tool-running | M |
| (vi) self-denied background ask, alone | none | none | **none** | M |
| (vi) R6 sweep: BG self-denied after main's real ask (120 runs) | 0 bad; alert 12 s | 20/120 BG alerted, 20/120 false `resolved`; 5-26 s | **0/0/0; 5-6 s** (7 s without PostToolBatch) | M |
| (vi) R1-rev sweep: BG self-denied *before* main's ask (60 runs) | 0 bad; 11.5-12 s after the dialog | 0 bad; 5-6 s | **0 bad; 5-6 s.** Without PostToolBatch: **20/60 named BG** (BG asked 0.5 s before main) | M |
| (vii) parallel asks, one agent (A then B queued) | B@12 R@21 B@32 R@41 | B@6 R@21 B@32 R@41 | **B@6 R@41**: one alert, no gap | M |
| (vii) the same with identical inputs | same | same | **B@6 R@41** | M |
| (viii) no listing: lone dialog | B@12 R@61 | B@7 R@61 | **B@7 R@61** | M |
| (viii) no listing: subagent dialog | names main, never resolves | SUB@7 (main, stuck, without agent_id) | **B:SUB@7 R:SUB@61** | M |
| (viii) no listing: Esc after the Notification | stuck (reminders) | stuck | stuck. Same as main: nothing can say Esc | M |
| (ix) remote sessions | remote daemon decides | same | **same**: the mechanism runs in the remote's own daemon against its own local listing. `remote.ts` (ssh roster, status only) feeds `RemoteSession` rows, never the registry, and is untouched. A remote with no `claude` on PATH behaves as (viii). | R |
| (x) Codex: approval then Interrupt | B@31 R@35 | B@31 R@35 | **B@31 R@35** (identical) | M |
| (x) Codex sibling stall at 16 min (S4c) | idle | thinking (F4) | **idle** | M |
| AskUserQuestion answered at 30 s | B@12 R@30 | B@7 R@30 | **B@7 R@30** | M |
| AskUserQuestion, Esc at 30 s | stuck | R@32 | **R@32** | M |
| AskUserQuestion, listing lags (busy to 6 s) | B@12 R@30 | B@7 R@30 | **B@7 R@30** | M |

### README findings

| Finding | main 07c3935 | 96d3367 | B | |
|---|---|---|---|---|
| VR3-86-1 RY (orig) | [] in the 7 s window | B:main@6, B:SUB@7, **R:main@7 (false)** | **B:main@6** | M |
| VR3-86-1 RY (realized, FIFO: A 0.4-60, SUB 60-90, B 90-120) | B:main@12 R@60 B:main@72 R@120 (SUB's dialog named main) | B:SUB@7 … B:main@102 (A named SUB) | **B:main@5 R@60 B:SUB@65 R:SUB@90 B:main@95 R@120**: exact | M |
| VR3-86-2 RX (orig) | B:main@5 | B:main@5, B:SUB@13, **R:main@13 (false)** | **B:main@5**. B has no retraction. | M |
| VR3-86-3 stale README paragraph | n/a | doc false | n/a. The behaviour probe gives B:main@12 on all three (an ask 3.4 s old cannot own a Notification). | M |
| VR3-86-4 / F7 mutation survivors | n/a | 7/33, 11/25 | **not run against B**: an open item (risk 7) | — |
| VR3-86-5 / F6 retracted block counted (S7) | n/a | blocksBegun 2 for 1 dialog | **1** (no retraction; every change goes through `transition`) | M |
| VR3-86-6 CHANGELOG wording | n/a | doc | n/a (B would need its own CHANGELOG) | — |
| F1 S1 (orig) | B@15 R@61 B@72 | B:main@8, B:SUB@10, **R:main@10**, B:SUB@70, R:SUB@95 | **B:main@10 B@70 (reminder) R@95** | M |
| F1 S1 (realized) / S1-control | B@15 R@61 B@72 R@91 / B@15 R@61 | B@8 R@9 B:SUB@10 … / B@8 R@61 | **B:main@10 B@70 R@91 / B:main@10 R@61**. SUB never named. | M |
| F1 S1-control, user active | B@21 | B@8 | **B:main@16** (ambiguity waits for the 12 s check) | M |
| F2 S2 dead=true (orig and realized) | B@12 R@21 B@32 …, main blocked | B:main@6 R@21 **B:SUB2@22 R:SUB2@45**; main never blocked on B | **B:main@5 B@65 B@125**: main blocked at 180 s | M |
| F2 S2c | B@13 R@61 B@72 … | B@7 R@61 **B:SUB@66 … R:SUB@300**; main idle at 400 s | **B:main@8 B@68 … B@368**: main blocked at 400 s | M |
| F3 "real prompt never dropped" (S2 dead, F3R V1, V2) | holds | false (V1 names SUB2 for 45 s; V2: main never alerted, idle) | **holds** in all three (B:main@5/6 + reminders). Caveat in R1-rev without PostToolBatch: named wrong, never dropped. | M |
| F4 S4 at 300 s (SUB quiet since 5 s, SUB2's dialog up) | SUB idle, but SUB2's dialog named main | **SUB thinking** (active 4.9 s, keeps banking) | **SUB idle** (active 34.9 s), SUB2 blocked, main tool-running | M |
| F4 S4b (needs_input on main, 1 h) | SUB idle | **SUB thinking** | **SUB idle** | M |
| F4 P5 (SUB in a live 10-min build while SUB2 blocked) | **SUB idle** (wrong) | SUB tool-running | **SUB tool-running** | M |
| F4 FileChanged during the block | **main idle** (FileChanged ends it) | blocked | **blocked** | M |
| F5 S5 (needs_input during an unannounced block, Esc) | B@8 B@68 | **[] (dropped)** | **B@5 B@65** (alerted) | M |
| F5 S5b / R4 (needs_input, then Esc) | blocked, reminders | waiting | blocked, reminders (as main). **A regression against 96d3367 on this row**: B keeps reminding after Esc, the price of never dropping a come-look notice (F5). | M |

### Hunt S1-S8 and verify R1-R6

| Case | main 07c3935 | 96d3367 | B | |
|---|---|---|---|---|
| R1 (BG self-denied newer than main's unseen dialog; bgNext 3-40 s) | B@12 | bgNext ≥8: **B:SUB2@6** then main at 13-45 s | **B:main@5** (7 s without PostToolBatch) | M |
| R2 | B@12 | B@5 | **B@5** | M |
| R3 (parent decays under a subagent's dialog) | see (v) | ok | ok, see (v) | M |
| R4 | see F5 | | | M |
| R5 (stale claim + claimless dialog at 6/9/12/30 s) | alert at dlgAt+12, then **never resolves** | dlgAt=6: **B@7 dated from the stale claim**; else as B | **B at dlgAt+12, R at dlgAt+~30**: the stale ask is retired by the busy poll, and the claimless dialog is caught by its Notification and cleared by the listing | M |
| R6 sweep | see (vi) | | | M |
| R1-min | reasoned as R1 | | FIFO puts main's ask first, so main is alerted | R |
| S2b (plan-approval-like dialog after an approved tool) | B@34 | B@5 R@21 B@34 | **B@5 R@21 B@34** | M |
| S3 notice=true (main answered at 4, its tool runs; SUB queued, up 4-30) | B:main@16, R only at main's PostToolUse @64 | B:main@5 B:SUB@11 R:SUB@31 **R:main@32** (both blocked 11-31) | **B:main@5 B:SUB@11 R:main@11 R:SUB@31** (corrected by the grid at the Notification) | M |
| S3 notice=false | nothing at all | B:main@5 R@32 (wrong name) | B:main@5 R@32 (wrong name; residual 2) | M |
| S6a discovery down | see (viii) | | | M |
| S6b claimless Notification at 16 s | main | main | **main** | M |
| S6c claimless Notification at 7.6 s | main | **SUB** | **main** (SUB's solo ask fails the grid) | M |
| S6d masked session ("input needed" throughout) | B:main@12 R@30 **B:main@41** (SUB's named main) | same as main | **B:main@7 R@30 B:SUB@36 R:SUB@55** | M |
| S7 counters | | 2 | **1** | M |
| S8 (main's A up 0.4-20, SUB's queued 20-40) | B:main@12 R@21 B:main@32 (SUB's dialog named main) | **B:SUB@6** (main's dialog named SUB) R@41 | **B:main@7 R@21 B:SUB@26 R:SUB@41** | M |
| F1v control/P2/P3 (main's dialog answered at 4-5 s, long tool) | none | B@5 R@7 | B@5 R@7; **none with evidenceDwell** | M |
| F1R V2/V3 (B close to the Notification) | B@15 R@61 B@72 R@91 | **SUB named** | **B:main@10 B@70 R@91** | M |
| F1R V4/V5 | extra R/B | extra R/B | **one block, R@91/98** | M |
| M19c (Esc, then a claimless dialog) | B@20 | B@5 R@7 B@20 | B@5 R@7 B@20; **only B@20 with evidenceDwell** | M |
| MONO (zzv-vr3-refute) | B:main@12 | **B:SUB@7** (base) | **B:main@5** | M |
| Fan-out: 3 subagents ask within 0.2 s, answered in turn | B:main@13, never resolves | B:c3@7, one name for 3 dialogs | **B:SUB@8 R@21 B:SUB2@26 R@41 B:c3@46 R@61** | M |
| Ghost sweep: SUB answered at 0.8 s, tool runs on; main's dialog 1-4 s later (25 runs) | 0 bad; 11.5-12 s | 0 bad; 5-6 s | **0 bad; 5-7 s** | M |
| Close-claims sweep: SUB answered at 0.8-3 s, main asked 0.3-0.8 s after SUB (70 runs) | 0 SUB alerts | 0 SUB alerts | **14/70 SUB alerted first**, then corrected to main at the Notification; main never lost | M |
| Early-answer sweep: lone dialog answered at 1-5.5 s (30 runs) | 0 alerts after the answer | **15/30** | 15/30; **0/30 with evidenceDwell** | M |
| Identical input, two agents, both ask | B:main@12 R@21 B:main@32 | B:SUB@6 R@40 (main's named SUB) | **B:main@7 R@21 B:SUB@26 R@40** | M |
| Identical input, two agents, only SUB asks | B:main@12 | SUB ok (main without agent_id) | **SUB** with agent_id; **main (wrong) without agent_id** (residual 4) | M |

96d3367's own `test/claude-permission.test.ts`: 56/115 pass against B. Of the failures, 42 assert claim
internals (`dialogSince`, `dialogHeldAt`, `CLAIM_WINDOW_MS`) and others encode rules B deliberately
changes, for example "pre_tool ends a block". The rest of the suite passes: 1358 tests. The one failing
file, `observability.test.ts`, is flaky and also fails on main.

### B with `evidenceDwell` (the recommended configuration)

The tables above report B with the option off, the prototype's default. With it on (measured, same
corpus, `C86_EVIDENCE=1`), every row not listed here is identical: no new lost, false or misnamed alert
anywhere. The rows that change:

| Case | B (option off) | B with evidenceDwell |
|---|---|---|
| (i) lone dialog, all phases | B@6 | **B@7** |
| (i) user typing | B@6 | B@8 |
| (ii) Esc at 20 s / subagent Esc | B@6 R@21-25 / B:SUB@6 R@21 | B@7 R@21-25 / B:SUB@7 R@21 |
| (iii) approve quick / long tool | B@6 R@21 / R@22 | B@7 R@21 / R@22 |
| (v) subagent dialog | B:SUB@6 | B:SUB@7 |
| (vi) R6 sweep / R1-rev sweep | 0 bad, 5-6 s / 5-6 s | 0 bad, 6-7 s / 6-7 s |
| (vii) parallel asks | B@6 R@41 | B@7 R@41 |
| S2 dead / F3R V1, V2 | B@5 / B@5, B@6 | B@7 / B@7, B@7 |
| S3 notice=true | B:main@5 B:SUB@11 R:main@11 | B:main@7 B:SUB@11 R:main@11 |
| S8 / RY | B:SUB@26 / B:main@5 … B:SUB@65 | B:SUB@27 / B:main@6 … B:SUB@66 |
| F1v control/P2/P3 (answered at 4-5 s) | B@5 R@7 (false) | **none** |
| M19c (Esc at ~6 s) | B@5 R@7 then B@20 | **B@20 only** |
| Early-answer sweep | 15/30 alert after the answer | **0/30** |
| Ghost sweep / close-claims sweep | 5-7 s / 14/70 | 6-7 s / 14/70 (unchanged) |

Unchanged: (iv), (viii), (x), AskUserQuestion, S1, S1-control, S2c and the README rows not listed. They
are either alerted by the Notification, which is evidence in itself, or not alerted at all.

## Alert latency

Lone main-agent dialog with no other ask in the session: **~6 s after PreToolUse (~5.2 s after the dialog
appears)**, every poll phase.
- With `evidenceDwell`: ~7 s (6.2 s after the dialog).
- With the user typing at the terminal: 6 s, or 8 s with `evidenceDwell`.
- With no listing: 7 s (the Notification).
- Main: 12 s. 96d3367: 6 s.

Several agents with open asks (ambiguous head): 6-7 s after the dialog, since it waits for the
Notification; ~13 s after the dialog if the user is active and only the second 6 s check fires (S1-control, user active: alert at 16 s, dialog at 3.4 s).

## Risks

1. **PostToolBatch is binary-read, not captured live.** Without it, self-denied asks leave only on a
   listing gap or the agent's Stop.
   - Measured fallback: R6 is still clean (7 s).
   - R1-rev names the background agent in 20/60 runs (self-denied ask ≤0.5 s before the real one).
   - Before shipping, capture PostToolBatch, including a self-denied background ask, a parallel batch,
     and Esc.
2. **PostToolBatch carries every call's `tool_input` and `tool_response`.** A batch of large reads can
   exceed the daemon's 1 MiB body limit (`MAX_BODY_BYTES`), and an http hook that gets an error shows it
   in the user's session.
   - It needs a streaming or ids-only body reader, or an accept-and-drop with a counter, for that hook.
   - SEC-01 holds: the payload is read for ids and discarded, never written.
   - Also unknown: the minimum Claude version that knows `PostToolBatch`, and whether an older version
     rejects a `hooks.json` that names an unknown event. Must be checked before registering it.
3. **FIFO has binary-read exceptions.**
   - Auto mode's timed (auto-deny) dialogs go on top.
   - Plan approval and other non-tool dialogs have their own placement.
   - Teammate and async-agent asks go "under".
   - A dialog that jumps the queue makes the head look pending when it is not, which gives a wrong name.
     R5's "no ask fits, so the dialog is claimless (main)" absorbs the common cases, and the listing gap
     retires the rest.
   - Not exercised: auto mode with a denial fallback dialog.
4. **The grid's resolution is ~1 s.** Two dialogs that mount within ~0.8 s of each other cannot be told
   apart by the Notification. That needs a near-instant answer, measured as residual 2 (14/70 in the
   adversarial sweep, corrected at the Notification). It also relies on one Notification per dialog
   mount (`wMe` resets `sent` on `[message, type, H]`; if `H` changes mid-dialog, a second Notification
   for the same dialog could advance the queue wrongly). Bounded: retirement needs another ask that
   fits.
5. **Correlation can miss.**
   - A PreToolUse hook that rewrites the input breaks the digest; the fallback is agent+tool, oldest
     first.
   - With no `agent_id` on PermissionRequest, identical inputs from two agents where only one asks pick
     main's call (residual 4, measured).
   - An uncorrelated claim (`callId` null) still queues and blocks. It just cannot exit by id, so it
     leaves by listing, Stop or Notification retirement.
   - Measured on the original probe timelines, which reuse one `tool_use_id` and identical inputs for
     every call: results are still exact.
6. **Restore (DMN-06) is not exercised.** Queues are not persisted. A restored block has no ask and
   should become a notice ended by the listing; the prototype does not wire `adopt()` for that.
7. **Not mutation-tested.** B needs its own mutation run and a test file. 96d3367's tests target its
   internals.
8. **A lost PostToolUse leaves an open call.** That agent then does not decay while the listing reads
   `waiting`, which is bounded by the dialog's lifetime: `idle` decays it.

## User-visible trade-offs

- Alerts arrive at ~5-7 s instead of ~12 s, are named after the agent whose dialog is on screen, and
  clear within one poll on Esc or approval.
- When several agents have asks open at once and the first might have been answered unseen, the first
  alert waits for Claude's own Notification (~6 s after the dialog appears), not the first poll: about
  1-2 s later in that case only.
- In the rare race where a dialog is answered within ~1-3 s while another agent's dialog is queued right
  behind it, the alert can name the first agent until the Notification (or the next empty-screen poll)
  corrects it.
  - The correction is a `resolved` for the first agent and a new `blocked` for the second: one extra
    doorbell pair.
  - Focus is per session/pane (PSH-11), so "take me there" lands on the right pane either way.
- Parallel asks from one agent are one continuous block with one alert, not alert / resolved /
  re-alert.
- `agent_needs_input` and worker prompts behave as on main: never dropped, and Esc does not clear them,
  only the agent's next event does. That is one more reminder than 96d3367 in R4/S5b, but never a lost
  alert (F5).
- With `evidenceDwell` on (recommended): no alert for a dialog answered within ~4 s, at ~1 s more latency
  when the alert does fire. With it off, behaviour matches 96d3367: an early answer can produce
  `blocked` followed by `resolved` 1-3 s later.
- A claimless dialog (plan approval and similar) still alerts only through its Notification (~12 s), as
  on main. The listing cannot say whose it is, and B does not guess.

## Prototype and reproduction

- The prototype worktree has been removed. To rebuild it: `git worktree add --detach <path> 96d3367`, then
  apply `correlate.diff` part 2. That diff runs from 96d3367 to B for all of `src/`, and it turns
  96d3367's registry into B's (main's registry plus the queue). Then add a `PostToolBatch` entry to
  `hooks/hooks.json` that mirrors the `PermissionRequest` one. Part 1 is the same change shown against
  main, hooks included.
- Harness: `correlate-evidence/zz-c86.test.ts`. Copy it into `test/` of any tree (07c3935, 96d3367 or the
  candidate) and run:
  `C86_TREE=<label> C86_OUT=<jsonl> C86_CORPUS=orig|real|both C86_AGENTIDS=0|1 C86_BATCH=0|1 C86_EVIDENCE=0|1 npx vitest run test/zz-c86.test.ts`
- Results:
  - `correlate-evidence/out-orig.jsonl` (original timelines on main and 96d3367)
  - `out-orig-cand.jsonl`
  - `out-real-{main,p86,cand}.jsonl` (cand in ids×batch×evidence modes)
  - `compact.txt` (the side-by-side table these scorecard rows come from)
  - `s4mid.jsonl`
