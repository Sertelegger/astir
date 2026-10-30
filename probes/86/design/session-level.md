# #86 redesign, candidate A: the permission block belongs to the session

Designer: candidate A (session-level block). Prototyped, and every claim in the
scorecard marked **M** was measured by replaying the timeline through the real
`Registry` and `NotifyLoop` on a fake clock, in all three versions (07c3935,
96d3367, candidate). Marked **R** = reasoning only.

- Prototype diff: `session-level.diff` (next to this file). It is against
  280b316 and touches `src/model/registry.ts`, `src/contract/{event,capabilities}.ts`,
  `src/adapters/claude/normalize.ts`, and adds a probe `test/zsl-baseline.test.ts`.
  The worktree it was built in is removed. Nothing is committed.
- Evidence: `session-level-evidence/`. It holds raw vitest output and logs for
  every probe file in all three versions, and the baseline/adversarial replay
  (`baseline-report.txt`, `base-*.jsonl`).

## 1. The idea in one paragraph

Two signals see a dialog and name no agent: the `claude agents --json`
sighting and the `permission_prompt` Notification. 96d3367 tried to attribute
them to one of several per-agent claims, and every heuristic opened a new
failure. Candidate A stops attributing. **A permission block is the
session's.** It shows on the session's main agent row (the session's pane,
which is all PSH-11 can focus). A `PermissionRequest` (an "ask") never blocks
anything and never chooses whom a block names. It only *dates* the block, and
once attached to it, says which agent's progress can end it. The listing
leaving the dialog ends the block. So does attributable progress: the call
that asked finishes (matched by an in-memory digest of `tool_name` +
`tool_input`), its agent stops, or the main agent ends its turn.

## 2. Where the block lives: on the main agent, not on a separate marker

I chose to show it on the main agent (`agentId === sessionId`), state
`blocked`, reason `permission_prompt`. That is also how 07c3935 treats the
agent-less Notification today.

| Requirement | Why the main agent row is right |
|---|---|
| PSH-11 (take me there) | Focus is per session/pane. `astir focus` raises the session's window. A subagent has no window of its own, so naming it adds nothing you can act on. |
| PSH-01 (identify the session and the reason) | The envelope body is `host · repo · session8 · reason` (`notify/envelope.ts`). No agent name is ever shown. `agentId` is only the key that pairs `blocked` with `resolved`. **Alerts do not need an agent name.** With the key always `(session, session)`, a subagent's dialog alerts once (baseline v). |
| PSH-08 / VIEW-08 / VIEW-12 (blocked count per session, on its row) | A session shows one dialog at a time, so counting one block per session is the honest count. 96d3367 could count two for one dialog: the retraction double-count (F6). |
| VIEW-09 (overview, blocked first, grouped by session) | The session's root row is blocked, so the group sorts first. The agent tree already rolls the worst state up to the root (`status/agents.ts`). |
| PSH-10 (acknowledge without pretending) | Acknowledgement acts on the session's block. A new block (after one ends) alerts again. |
| MOD-04 | `blocked` is entered on the permission signal and left on attributable progress or the listing (amended from "the next tool event"). |
| G4 / MOD-05 | The session's wait is banked as `blockedMs` on main. The asking subagent banks its dialog as active (see trade-offs; measured A4). |

**A separate session marker was rejected.** `blockedAgents`, `blockedCount`,
`acknowledge`, `markAnnounced`, `/state agents[].announcedAt`, the frames,
overview, `status --line` and the menu bar all iterate agents. A marker would
need a parallel path through each of them, and the doorbell key would still
be per session. The user would gain nothing from it.

**What a subagent's own row shows while the session is blocked:** its own
state from its own hooks. That is `tool-running` with its tool name (e.g.
`Bash`), because it fired `PreToolUse` and nothing has finished. While its ask
is attached to the block it is exempt from idle decay, because its silence is
the dialog. Afterwards it moves on its own events. Other agents keep
everything as before: their tool-running states and their idle decay.

## 3. Mechanism (exact rules)

Scope: a provider whose capability says `promptScope: "session"` (Claude).
Codex declares `promptScope: "agent"` and keeps 07c3935's per-agent path
unchanged (CAP-02: the registry reads the capability, never a provider name).

1. **Ask.** `PermissionRequest` adds `{at, agentId, callKey}` to the session's
   open asks. No state changes. The asking agent stays `tool-running`.
2. **Begin.** The session blocks (main → `blocked`/`permission_prompt`) when:
   - (a) a listing poll **begun** at `p` reads `permission-dialog`, and
     `p ≥ clearedAt` (a poll begun before the last block ended saw that
     block's dialog); or
   - (b) an agent-less `permission_prompt` Notification lands, unless it lands
     less than 5 s after the listing found the screen clear. Claude sends it
     only once a dialog has been up ≥ 6 s (measured 6.17–6.58 s), so it is
     about the dialog just answered.
3. **Date.** `since` = the oldest open ask with
   `at ≥ max(evidence − 10 s, clearedAt, [sightings only] quietAt − 1 s)`, else
   `evidence` (the poll start, or the Notification's arrival). `quietAt` is the
   start of the last poll that saw no dialog. The floor is not applied to the
   Notification: AskUserQuestion reads `busy` about 1 s in, and the listing
   never says "permission prompt" for it. As with every transition (MOD-05
   banking), the block is never dated before main's own last state change.
   Every open ask in that span is **attached** to the block, and so is every
   ask made while it stands.
4. **Confirm.** A later sighting during the block records `seenAt` (a poll
   start).
5. **End by listing.**
   - `at-prompt` from a poll begun ≥ 1 s after the block began ends it. This
     is Esc, so main → `waiting`.
   - `working` from a poll begun after `seenAt` ends it. The dialog was
     answered, so main → what it was doing.

   Either way, asks made ≥ 1 s before that poll are closed, and
   `listingClearedAt = p`. `other-dialog` is no evidence and changes nothing.
6. **End by attributable progress.** These close an attached ask:
   - a `post_tool`/`tool_failed` whose `(agentId, callKey)` matches it;
   - its agent's `stop`, `subagent_stop` or `session_end`.

   When the last attached ask closes, the block ends. If other attached asks
   remain, the block stands and `seenAt` is set to now if it was null, so the
   next quiet poll can end it.
7. **End by the main agent.**
   - Main's `stop`, `session_end` or `session_start` ends it: no dialog
     outlives the turn.
   - Main's own progress also ends (a) a block that never had an ask (a
     claimless dialog such as plan approval), and (b) any block while the
     listing has given no decisive screen for 30 s (discovery down, or a
     session whose listing only ever says `other-dialog`). That is exactly
     07c3935's rule, kept as the degraded mode.
8. **Retire.** An agent's `pre_tool` retires its earlier open asks: it moved
   on, e.g. after a background agent's self-denial. Retiring never ends a
   block, because a parallel call's `PreToolUse` may land while the first
   call's dialog is up.
   - **Bounds:** open asks are capped at 32 and expire after 10 min. An ask
     attached to the standing block is exempt from both, because a dialog can
     be up for hours.
   - **Detach:** when a block ends, every ask still open is detached, so it
     cannot hold or end a later block it was never part of.
9. **Under the block.** Main's own events that do not end it update a
   `resume` record (state and tool) while main stays blocked. Other agents'
   events apply normally. When the block ends, main resumes a working state
   and its `lastActivityMs` is refreshed. Without that refresh, main decayed
   to idle the instant a long block ended (found by adversarial case A5).
10. **Need.** An `agent_needs_input`/`worker_permission_prompt` during the
    block is remembered (`need`). When the dialog ends by rule 5 or 6, main
    stays blocked on it, with the same block, date and announcement (F5).
    Main's own progress ends it, as MOD-04 always did. A prompt that arrives
    on top of an existing need-block keeps the need.
11. **Decay.** 96d3367's session-wide decay skip is removed (F4). Only agents
    holding an attached ask skip idle decay while the block stands.
12. **Who is named.** The doorbell key is `(sessionId, sessionId)`. The alert
    text names host, repo, session and reason. No agent is named.

Nothing is retracted, moved between agents or held for another agent, which
was the source of every 96d3367 failure. Each rule reads and writes only the
session's block and the main agent.

## 4. State

| Where | Field | Meaning |
|---|---|---|
| `SessionRecord.prompt.asks[]` | `{at, agentId, key, attached}` | Open asks: capped at 32 with a 10 min TTL, except asks attached to the standing block, which are never dropped. All are detached when a block ends. |
| `SessionRecord.prompt.block` | `{beganAt, seenAt, hadAsks, resume{state,tool,toolPath}, need}` | The session's current block. `null` when none. |
| `SessionRecord.prompt` | `clearedAt`, `listingClearedAt`, `quietAt`, `screenAt` | Dating floors, the stale-Notification guard, and whether the listing is live. |
| `AgentRecord` | removed: `dialogSince`, `dialogHeldAt`, `dialogSeenAt` | No per-agent claim state at all. |
| `AstirEvent.callKey?` | 32-hex sha256 of `tool_name` + canonical `tool_input` | Set by the Claude adapter on `pre_tool`/`post_tool`/`tool_failed`/`permission_request`. |
| `ProviderCapabilities.promptScope` | `"session"` (Claude) / `"agent"` (Codex) | CAP-02 switch. |

Everything is in memory only. `snapshot()` lists its fields one by one and
includes none of these, so nothing new is persisted. `callKey` is a digest,
never written to disk, a frame or a log (SEC-01). Hashing in memory is
allowed. `adopt()` rebuilds a block for a restored main that was blocked on
`permission_prompt`, so the listing can end it. The HTTP hook answer is
unchanged, with no `decision`/`hookSpecificOutput` (NG4; 96d3367's own test of
this passes up to its `dialogSince` line).

## 5. How it was measured

- I used three throwaway worktrees: 07c3935, 280b316 (= 96d3367 plus the
  probes), and the candidate.
- I copied every `probes/86` file into each worktree's `test/`, fixing up the
  fixture and log paths (`session-level-evidence/install.sh`).
- For the 96d3367-targeted files to run on 07c3935, I added export-only shims
  to the 07c3935 worktree: `CLAIM_WINDOW_MS`, `claudeScreen`, `pollInto`. In
  the probe copies there, a PermissionRequest's null event counts as
  "applied". The shims do not change behaviour.
- I wrote one version-agnostic probe, `test/zsl-baseline.test.ts`, for
  baselines (i)–(x), AskUserQuestion, plan approval and five adversarial
  timelines (A1–A5). Most cases are swept over 5 poll phases (0–4 s).
  Resolution is 100 ms; polls are every 5 s and land 300 ms later; tick and
  pulse run every 1 s.
- Probe results: 114 probe tests per version. The probe `expect`s are
  aspirational, not acceptance oracles: on S2, 07c3935 itself fails, because
  reminders are `blocked` envelopes too. They fail as follows:
  - 07c3935: 21.
  - 96d3367: 18.
  - Candidate: 9. Four of these assert behaviour the candidate deliberately
    replaces, each in two copies of the hunt file: S2 counts B's alert while
    the block continues (2 tests); S3 expects the subagent to be named; S5b
    expects `waiting` after Esc where the candidate keeps the need. The ninth
    is a synthetic healthz count, explained under risk 12.
- Scoring is by the README's named defects: false `resolved` while a dialog
  is up, a real dialog never alerted, a wrong or extra agent alerted, an agent
  wrongly held out of decay, a come-look notification lost, and a double
  count.
- **End to end:** the `callKey` path was measured end to end through the
  real `Daemon` (`/hook/claude`, then `validateEvent`, then the registry).
  The sequence is PreToolUse, PermissionRequest, a sighting, then a
  PostToolUse at 20 s while the listing is still live. Main leaves `blocked`
  on the PostToolUse. On 07c3935 the PermissionRequest answers 422 (unmapped).
- **Long dialogs:** measured at 15 min (L1, L2), past the asks' TTL.
- **Fix found in review:** an earlier prototype kept `attached` flags after a
  block ended. Run on the candidate code with 07c3935's listing-less probe
  harness (`vr3f1rmain`), F1R V1 showed it: a subagent's unrelated
  completion at 120 s falsely resolved a later block. Rule 8's detach fixed
  it. Every other probe output was unchanged.
- Regular suite on the candidate: 1359/1361 pass outside
  `claude-permission.test.ts`. The 2 failures are in `announced.test.ts`,
  which builds Claude `permission_prompt` Notifications that name subagents,
  something Claude never sends. Those tests should use an agent-scope provider.
  56/115 of `claude-permission.test.ts` fail. That suite encodes per-agent
  attribution (dialog fields, subagent blocked, retraction, noticeOwner) and
  would be replaced.

## 6. Scorecard

Times are seconds from the first hook. In a story, `blocked@6` means an
envelope was sent at 6 s. "rem" = a PSH-02 reminder.

### README findings (round 3)

| Case | 07c3935 | 96d3367 | Candidate | M/R |
|---|---|---|---|---|
| VR3-86-1 (RY: parallel re-claim, sub's claim 1 s later) | no alert in the probe window (dwell from Notification) | false `resolved:main@7` while main's dialog is up; alert moves to sub | `["blocked:main@6"]`, sub never blocked | M |
| VR3-86-2 (RX/RX2/RX3: retraction of a Notification-made block) | main blocked, no retraction | RX `resolved:main@13` + sub alerted; RX2 same; RX3 main retracted at 5.5 | main blocked throughout, `["blocked:main@5"]` / `["blocked:main@7"]`; sub never | M |
| VR3-86-3 (stale README paragraph, "lone young claim") | main blocked | main blocked, docs contradict code | main blocked by construction; the noticeOwner docs disappear | R |
| VR3-86-4 / F7 (mutation survivors) | n/a | 7/33 and 11/25 survive | rules removed (retract, noticeOwner, hold); the **new rules are not mutation-tested yet** | R |
| VR3-86-5 / F6 (blocksBegun counts a retracted block) | n/a | 2 for one dialog (S7, healthz) | 1 (S7 before=1 after=1; healthz `blocked:1`) | M |
| VR3-86-6 (CHANGELOG wording) | n/a | wrong | to be rewritten for the new model | R |
| F1 (S1, and F1R V0–V6) | `blocked@15, resolved@61` while B up, `blocked@72` | `blocked:main@8, blocked:SUB@10, resolved:main@10` …, SUB alerted for a dialog approved at 0.8 | `blocked:main@8, rem@68, resolved@95`: one block across A and B, no false resolve, SUB never. Identical across all 8 F1R variants | M |
| F2 (S2 dead SUB2) | `blocked@12, resolved@21, blocked@32, rem…`; main blocked at 180 | B never alerted; SUB2 alerted `@22`, resolved `@45` | `blocked@5, rem@65, rem@125`: continuous through A then B; main blocked at 180; SUB2 never | M |
| F2 (S2c) | `blocked@13, resolved@61, blocked@72…`; main blocked at 400 | SUB alerted 4×; main **idle** at 400 with B up | `blocked@6`, reminders to 366; main blocked at 400; SUB never | M |
| F3 ("real prompt never dropped", f3r V0/V1/V2/V0-resend) | main blocked at end | V0: no main alert after 45 s, blockedCount 0; V2: main idle | main blocked at end in all; V0 blockedCount 1 | M |
| F4 (S4, S4b, S4c; f4-probe P1–P5) | SUB idle by 35 s (activeMs 36 900); S4b SUB idle; S4c Codex sibling idle | SUB thinking for the whole block (activeMs 610 900); S4c thinking | same as 07c3935: SUB idle, activeMs 36 900; S4c idle. P5 (sibling's live build) idle, as on 07c3935 (trade-off) | M |
| F5 (S5: `agent_needs_input` during an unannounced block, Esc) | `blocked@8, rem@68` | `[]`, never alerted | `blocked@5, rem@65`; after Esc main stays blocked on `agent_needs_input` | M |

### Verify sweeps (R1–R6, F1, F3/F4, M19, R1-min, refute) and hunt S1–S8

| Case | 07c3935 | 96d3367 | Candidate | M/R |
|---|---|---|---|---|
| R1 (self-denied bg ask newer than main's dialog, 5 bgNext values) | `blocked@12, resolved@60` | bgNext ≥ 8 s: **bg alerted**, main delayed to 13–45 s | `blocked:main@5, resolved@60` for all 5 | M |
| R2 (bg ask while main's dialog is seen) | @12 | @5 | @5; resolved@60 | M |
| R3 (parent while the sub's dialog is up) | `blocked:main@13, rem@73`, never resolved | sub `@7`, resolved@91 | main `@7, rem@67, resolved@91` | M |
| R4 (`agent_needs_input` during a seen block, Esc) | `agent_needs_input@11` + reminders | `blocked@5, resolved@7`: need lost | `permission_prompt@5`, then reminders as `agent_needs_input` | M |
| R5 (stale approved ask + later claimless "permission prompt" dialog, dlgAt 6/9/12/30) | `[]` ×4 (no Notification) | dlgAt 6: @7; 9/12/30: **never alerted** | 6: @7 (dated from the stale ask); 9: @16; 12: @21; 30: @36; each resolved 1–5 s after its dialog ends | M |
| R6 sweep (120 runs: bgAt × bgDelay × phase) | 120/120 main @12, 0 bg alerts, 0 false resolves | first main alert 5–26 s; **20/120 bg alerted + false resolve** | 120/120 main @5 (96) or @6 (24); 0 bg alerts; 0 false resolves; resolved@60 | M |
| R1-min | `blocked:main@16` | bg blocked at 5.3, main @7 | main blocked at 5.3, `@6` | M |
| F1 variants (zzv-f1 control/P2/P3/P4) | `[]` (no Notification) | `@5/resolved@7`, P4 `resolved@22` | identical to 96d3367 | M |
| F3busy (non-blocking notifications in a seen block, then busy) | no block | → tool-running, no envelope | same as 96d3367 | M |
| F4 fcAt (FileChanged before the sighting) | dated 6.4, `@15` | dated 0, `@5` | dated fcAt (0.5/2.0; main's FileChanged state change clamps the date), `@10` at that probe's sparse pulse cadence | M |
| M19c (Esc, then a claimless dialog 2 s later) | not blocked | `waiting`, never blocks the claimless dialog | blocked from 8 s (the sighting), dwell runs | M |
| M33c (new ask after the last sighting, then busy) | blocked | blocked | **thinking**: busy ends it (see risk 4) | M |
| refute MONO-* (6 variants) | no alert in window, main blocked | sub alerted in 5/6; false `resolved:main` in 2/6 | `["blocked:main@6"]` in all 6; sub never | M |
| S1 / F1R | see F1 | see F1 | see F1 | M |
| S2 / S2c | see F2 | see F2 | see F2 | M |
| S2b (plan approval after main's approved tool, dead SUB2) | `[]` | `blocked@5, resolved@21`; **plan dialog never alerted** | `blocked@5, resolved@22, blocked@31`: plan dialog alerted after its own dwell | M |
| S3 (main approves a long tool; SUB's queued dialog) | `blocked@16, resolved@64` (late resolve); with no Notification, `[]` | `blocked:main@5, blocked:SUB@11, resolved:SUB@31, resolved:main@32` | `blocked:main@5, resolved@32` (one continuous need) | M |
| S4 / S4b / S4c | see F4 | see F4 | see F4 | M |
| S5 / S5b | S5 see F5; S5b need-block survives Esc | S5 `[]`; S5b → `waiting` | S5 see F5; S5b main stays blocked on `agent_needs_input` after Esc (deliberate, 07c3935's outcome) | M |
| S6 (discovery down) | `@12` | `@7`, dated from the ask | `@7`, dated from the ask; S6c owner main; S6d masked `@7, resolved@30, @41` (07c3935 `@12, @30, @41`) | M |
| S7 (counter) | n/a | 2 | 1 | M |
| S8 (main's dialog, then SUB's queued) | `blocked@12, resolved@21`; SUB's dialog (20–40) never alerted | names SUB for main's dialog (`SUB@6, resolved@41`) | `blocked:main@6, resolved@41`, continuous | M |
| Daemon `/healthz` (zzv-vr3-healthz) | counts ingest blocks only | plain 1/2; retracted case 2 for one dialog | plain 1/2; retracted 1; "listing + ingest" 1, not 2: a plain Notification 1.1 s after an Esc is dropped by rule 2b (synthetic, impossible per the measured 6 s) | M |

### Baselines (i)–(x)

| Case | 07c3935 | 96d3367 | Candidate | M/R |
|---|---|---|---|---|
| (i) lone main Bash dialog: alert latency | `@12` (all 5 phases) | `@6` | `@6` (all 5 phases): 5.6 s after PermissionRequest, ~5.2 s after the dialog is visible | M |
| (ii) Esc clears within one poll | never: stays blocked, `rem@72` | resolved @21–25 (Esc at 20), main `waiting` | resolved @21–25, main `waiting` | M |
| (ii') Esc at 4 s, before any alert | no alert | phases 1–3: `@6` then resolved @7–9 | same as 96d3367 (risk 7) | M |
| (iii) approval clears at once (short tool, Post at 20.5) | resolved@21 | resolved@21 | resolved@21 | M |
| (iii') approval, then a 60 s tool | blocked to 80 (`rem@72`) | resolved @21–25 (next poll) | resolved @21–25 (next poll) | M |
| (iii'') L1: main's dialog up 15 min, PostToolUse at 900.5 | resolved@901 | resolved@901 | resolved@901 (the 15 min old attached ask matched) | M |
| (iii''') L2: a subagent's dialog up 15 min, a sibling working every 60 s | never resolved; asking sub **idle** at 31 s | names sub, resolved@901; main **idle** at 901 | resolved@901; the asking sub stays `tool-running` 15 min; main `tool-running` after | M |
| (iii) end to end through the Daemon (`/hook/claude`) | PermissionRequest 422; the sighting does not block | blocked by the sighting; the PostToolUse ends it | blocked by the sighting; the PostToolUse ends it by `callKey` (listing still live) | M |
| (iv) auto-mode approval | none (with and without listing) | none | none | M |
| (v) subagent's dialog alerts once | one alert `main@13`, resolved@41 (only when main's Agent tool ends) | one alert, names sub `@7`, resolved@31 | one alert `main@7`, resolved@31 (sub's PostToolUse matched its ask). A3 (sub's tool runs long): resolved at the next poll after approval | M |
| (vi) self-denied bg ask, alone | none (listing / no listing) | none | none | M |
| (vi) bg ask beside a real main dialog (bgAt −3…+8 s × 5 phases) | `@12` | `@6`–`@7` | `@5`–`@6` (earlier only when the bg ask is older than main's: never later, never stolen); no bg alert; no false resolve | M |
| (vii) parallel asks A, B from main (B queued, shown at 40, approved 120) | `resolved@41` while B up, `blocked@52` | same; plus a false `resolved@20` when B asks late | one block: `@6, rem@66, resolved@121` (vii, vii-preB, vii-late) | M |
| (vii') parallel auto-allowed Read finishing during A | `@12` | `@12` (the Read's PostToolUse dropped main's claim) | `@6`–`@8`, resolved@41 | M |
| (viii) discovery down: main dialog | `@12`, resolved@61 | `@7`, resolved@61 | `@7`, resolved@61 | M |
| (viii) discovery down: Esc | blocked forever, reminders | same | same (no worse than main) | M |
| (viii) discovery down: sub dialog | `@13`, stuck until main's Agent ends (90) | sub `@8`, resolved@31 | main `@8`, resolved@31 | M |
| (viii) discovery down: bg ask + main dialog | resolved@61 | resolved@61 | resolved@61 (via the 07c3935-parity rule) | M |
| (ix) remote sessions | `remote.ts` (DMN-09 ssh poll) never reaches `reconcile`: it builds display rows (`RemoteSession.status`) only. A remote block is found by the remote daemon's own listing and hooks, then sent by doorbell (PSH-06). | same; `parseProfileLines` carries `screen`, which `RemoteDiscovery` drops | same; no change to remote.ts. The remote daemon runs the same rules. Only the parse check was measured (96d3367's "remote rows carry screen" passes on the candidate) | R |
| (x) Codex | permissionSequence (auto-reviewed at 12 s): none; escSequence (Interrupt): none; unanswered: `@32, rem@92` | identical | identical (`promptScope: "agent"`); S4c sibling idle at 16 min (96d3367: thinking) | M |
| AskUserQuestion (listing: busy, then "input needed") | `@12`, resolved@31; Esc: stuck | `@7`, resolved@31; Esc: within a poll | `@7`, resolved@31; Esc: resolved within a poll | M |
| Plan approval (no PermissionRequest) | `@12` (Notification) | `@12`: needs the Notification | `@6`–`@10` (dwell from the sighting), resolved@31 | M |

### New adversarial timelines aimed at this candidate

| Case | 07c3935 | 96d3367 | Candidate | M/R |
|---|---|---|---|---|
| A1: a bg ask outlives the answer to a Notification-made AskUserQuestion block | `@12`, resolved@31 | names **bg**, resolved@45 | `@7`, resolved @31–36. Rule 6's `seenAt` was added for this case; without it, by reasoning, the block would stand until main's `stop` | M |
| A2: the Notification lands 0.35 s after a listing-seen approval; the tool runs to 70 s | false `blocked@13` until 70 | `resolved@8`, then false `blocked@13` until 70 | `blocked@6, resolved@8`, no re-alert (rule 2b) | M |
| A4: G4 over a 30 s sub dialog | main blocked 25.2 s; sub active 31 s | sub blocked 29.6 s; main active 31 s | main blocked 29.6 s; sub active 31 s | M |
| A5: two subagents ask at once (one shown, one queued) | `@13`, never resolved; main blocked at end | names SUB2, resolved@41; main **idle** in 4/5 phases | `@6`–`@7`, resolved@41; main `tool-running` (fixed by rule 9's activity refresh) | M |

## 7. Alert latency

For a lone main-agent Bash dialog, the alert came **6 s after PreToolUse in
every poll phase**. That is 5.6 s after `PermissionRequest`, about 5.2 s after
the dialog was visible. The dwell runs from the ask and is caught by the first
1 s pulse after it.

| Case | Alert at |
|---|---|
| Subagent dialog | 7 s |
| AskUserQuestion | 7 s |
| Discovery down (Notification path) | 7 s |
| Plan approval (no ask) | 6–10 s (sighting + dwell) |
| A stale ask inside the window | can bring it to the first pulse after the sighting (5 s in R1/R6) |

07c3935: 12 s. 96d3367: 6 s.

## 8. Complexity

- **Prototype vs 280b316:** 4 source files, +487/−390.
- **`registry.ts` vs 07c3935:** +573/−27. 96d3367's commit was +572 there.
- **Non-blank, non-comment code lines in `registry.ts`:** 508 on 07c3935, 691
  on 96d3367, 796 on the candidate. The candidate is **not smaller** than
  96d3367.
- **New state:** 6 session fields, a 5-field block record and a 4-field ask
  record. Three agent fields are removed. Plus the `callKey` contract field and
  the `promptScope` capability.
- **Rules:** about 12 (section 3). The difference is that no rule moves a
  block between agents, retracts one or holds a claim for another agent. Each
  rule is about one session's screen, so the rules do not interact through
  attribution. That interaction is what produced each review round's new
  failure.

## 9. Risks

1. **Early dating.** A stale ask (approved before any poll, or self-denied)
   inside 10 s and after the last quiet poll dates the block early. The
   alert then fires at the first pulse after the sighting, skipping the
   dwell, and `blockedMs` is overstated by up to 10 s. It is never a false
   alert, because a sighting or Notification proves a dialog. Measured: R5
   dlgAt=6, (vi) bgAt=−1000.
2. **Late clear by one poll.** When a stale attached ask outlives the real
   answer, the clear waits for the next quiet poll. Measured: S1-control
   resolved@65 vs 61; S2c-noparallel @63. With discovery down, the clear waits
   for main's own progress (07c3935 parity).
3. **Continuity.** A queued second dialog continues the first block. B gets
   no fresh alert; reminders continue on the PSH-02 cadence from A's alert. An
   acknowledgement of A also covers B, so PSH-10's "a new block alerts again"
   does not fire for B.
4. **M33: listing lag after a new ask.** A `working` poll after the last
   sighting ends the block, even if an ask arrived after that sighting. If that
   ask is an AskUserQuestion (the listing reads `busy` about 1 s into one),
   you get `resolved`, then a re-block from its Notification ~6 s after it
   shows, with no dwell. A mitigation is available but not prototyped: hold a
   `working` end until such an ask is ≥ 8 s old.
5. **Needs outlive Esc.** A need that arrives during or before a permission
   dialog keeps main blocked after Esc until main's next event (S5b, R4). That
   is 07c3935's outcome for that reason; 96d3367 ended it instead. What Claude
   shows for `agent_needs_input` is unmeasured.
6. **Unmeasured inputs the rules lean on.**
   - Does `PostToolUseFailure` carry `tool_input`? If not, a denied call's
     ask closes only by the listing or by its agent stopping.
   - Does a parallel call's `PreToolUse` land before or after the first
     call's `PermissionRequest`? Rule 8 tolerates both; only latency changes.
   - Does `PermissionDenied` fire for a background self-denial? If it does,
     registering it would close stale asks exactly.
   - Does Claude re-send `permission_prompt`?
   - The listing is assumed never to read "permission prompt" for a
     background self-denial.
7. **Esc inside the dwell.** If the first poll saw the dialog and the next
   poll lands after the dwell, Esc inside the dwell still alerts once, then
   resolves within about 1–3 s. 96d3367 does the same.
8. **Date clamped by main's own state changes.** A FileChanged or one of
   main's parallel completions between the ask and the sighting clamps the
   date to that change, because of MOD-05 banking. Measured: F4 fcAt; vii-read
   alerts at 8 rather than 6 in 3 phases.
9. **Siblings decay during a dialog.** A sibling running a long tool while the
   listing reads `waiting` decays to idle after 30 s (f4 P5), as on 07c3935.
   An option, not prototyped: judge non-asking agents with `stalledAfterMs`
   while a session block stands, i.e. bounded rather than 96d3367's unbounded
   skip.
10. **No mutation run.** The new rules have not been mutation-tested. Section 3
    is the list to mutate. Two defects were found and fixed during
    prototyping only because a timeline was added for them:
    - asks were TTL-pruned while still attached, which would have broken
      (iii) for dialogs over 10 min (now L1/L2);
    - stale `attached` flags carried across blocks (F1R V1, listing-less
      harness).

    A mutation pass would likely find more of that kind.
11. **Test churn.** `test/claude-permission.test.ts` (2 135 lines) must be
    replaced. In `test/announced.test.ts`, 2 synthetic tests need an
    agent-scope provider.
12. **Healthz probe count.** Rule 2b drops a plain Notification that lands
    1.1 s after an Esc, so 96d3367's healthz probe counts 1, not 2. This is
    deliberate: by the measured 6 s minimum, that Notification cannot be about
    a new dialog.

## 10. User-visible trade-offs

- **Nobody is named.** Alerts never name a subagent; none ever did in their
  text. The session's main row reads blocked. The asking subagent's row reads
  `tool-running <tool>`. "Take me there" is unchanged.
- **One block per stretch of dialogs.** A queued second dialog does not
  re-alert; reminders continue. There is no `resolved`/`blocked` flicker
  between parallel or queued dialogs: 07c3935 and 96d3367 both flicker in
  (vii).
- **`resolved` can be late.** It can arrive one poll (≤ 5 s) late when a stale
  ask is attached.
- **G4 accounting.** The session's wait is banked as main's `blockedMs`; the
  subagent banks its own dialog as active time (07c3935's split). 96d3367
  banked it on the subagent instead.
- **Claimless dialogs alert sooner.** Plan approval and other dialogs with no
  ask now alert from the listing, 6–10 s in, rather than only from the
  Notification (~12 s).
- **Esc clears quickly.** An Esc on AskUserQuestion or a Bash dialog clears
  within one poll.
- **`agent_needs_input` outlives Esc**, as on 07c3935.
- **With discovery down:**
  - the Notification alerts at ~7 s;
  - a subagent's approval clears at once (via `callKey`), where 07c3935 stayed
    blocked until main's Agent tool ended;
  - Esc never clears (as on 07c3935).

## 11. Open measurements worth doing before building it for real

1. **PostToolUseFailure:** does it carry `tool_input` on a denied or failed
   call?
2. **PermissionDenied:** does it fire for a background self-denial (resume,
   fork, dontAsk, plan)?
3. **Parallel-call order:** does a parallel call's PreToolUse land before or
   after the first call's PermissionRequest?
4. **AskUserQuestion lag:** how long can the listing read `busy` after its
   ask? This sizes the risk-4 mitigation.
5. **agent_needs_input:** what does the listing show while one is pending,
   and does Esc answer it?
