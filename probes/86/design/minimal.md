# #86 redesign: candidate C, a minimal change from main

**Verdict.** C keeps main's attribution: the agent-less `permission_prompt`
Notification blocks the main agent, and nothing else begins a block. It adds
two rules on top. (1) The block that Notification makes is dated back to when
the dialog opened. (2) The session listing's `idle` ends a permission block,
which covers Esc.

Every probe timeline and every baseline was replayed through the real
`Registry` and `NotifyLoop` on a fake clock, in three trees with one harness:
main (07c3935), held (96d3367) and C. In those replays C:

- alerts a lone dialog **6.45 s** after it appears (5.95 to 6.95 s), against
  11.45 s on main and 5.2 s on the held design;
- clears Esc within **3.3 s** (1.0 to 5.7 s), where main never clears it.

None of the held design's failure modes can occur in C. It has no claims, no
sightings that block, no retraction, and it never moves a Notification between
agents. All 120 R6 runs alert the real prompt, with no false alerts and no
false `resolved`.

What C does **not** fix is everything main already gets wrong:

- the alert names the parent, not the subagent;
- after a subagent's dialog or a long tool is approved, reminders continue
  until the main agent's next event;
- a FileChanged ends a block.

The measured fix for the second is a third, clear-only rule (C+busy, below).
It is outside the briefed two rules and is offered separately.

The 5 s target is missed by **about 1.3 s on median**. The floor is Claude's
own Notification gate: about 6 s after the dialog opens, plus up to 1 s
waiting for the next pulse. No design that blocks only on the Notification can
beat that floor.

The rule (1) the brief specifies ("the newest PermissionRequest within 10 s")
is the weakest of the three dating rules measured. A younger ask, from a
background agent that denies itself or from a parallel re-ask, delays the
alert by up to 5 s. That is never later than main. **Variant C0** dates the
block from the Notification itself (`now − 5 s`, a declared Claude
capability). In every replay, C0's alert came no later than the briefed rule's.
It needs no `PermissionRequest` hook at all. I recommend C0.

---

## 1. Mechanism: exact rules

### Rule 0: unchanged from main

| Rule | What it says |
|---|---|
| What blocks | Only a blocking Notification blocks: `permission_prompt`, `agent_needs_input` or `worker_permission_prompt`. It blocks the agent the event names. Claude's Notification never carries `agent_id`, so that is always **the main agent** (`agentId = sessionId`). |
| What never blocks | `PermissionRequest` and the listing never begin a block. |
| Who the alert names | The main agent of the session. PSH-11 holds: focus is per session and pane, so focus lands on the pane that shows the dialog. |
| What ends a block | Any next event for that agent: `pre_tool`, `post_tool`, `tool_failed`, `file_changed`, `stop` and so on. This is main's `nextState`, unchanged. Rule 2 adds one more way. |
| Last reason wins | A later blocking Notification on an agent that is already blocked overwrites `blockedReason`, as on main. |

### Rule 1: date the Notification-made block

This applies only when a `permission_prompt` Notification moves an agent
**into** `blocked`. A duplicate on an agent that is already blocked changes
nothing, so `transition` stays a no-op.

The date chosen is `since`, and it is clamped:

```
stateSince = min(now, max(since, agent.stateSince))
```

The clamp means the block never begins before the state being left. That
state's time is already banked, and an ask from before it, such as an
approved tool that has since finished, is not this dialog's ask.
`transition()` banks `[stateSince_old, at)` in the old state and `[at, …)` as
blocked (MOD-05 and G4).

There are three ways to choose `since`. All three were measured.

| Variant | `since` | Needs |
|---|---|---|
| **C (as briefed, `lit`)** | The newest `PermissionRequest` in the **session**, from any agent, within the last 10 s (`ASK_WINDOW_MS`). With none, `now`. | The `PermissionRequest` hook, a `permission_request` notification kind, and session-level `asks: number[]` (timestamps within 10 s). |
| C-ref | The newest ask that is at least 5 s old and within 10 s. Failing that, the newest ask within 10 s. Failing that, `now`. | The same as C. |
| **C0 (recommended)** | `now − CAPABILITIES[provider].promptNoticeAgeMs`. Claude declares 5 000 ms and Codex declares 0. | One capability field. No hook, no contract change, no state. |

**Why a date can never create a false alert.** Claude sends `permission_prompt`
only while the dialog is still up, and only after the user has been idle at it
for 6 s. That was read from the 2.1.312 binary, and the measured gap is 6.2 to
6.6 s after `PermissionRequest`. So a block made by this Notification is
already a real dialog at least about 6 s old.

The date therefore changes only two things: **when** the dwell is spent, and
how G4 time is banked. It never changes **whether** an alert fires, or for
whom. Because `since ≤ now`, C is never later than main.

PSH-16's purpose, that an auto-answered ask never alerts, is met by the
provider. Auto mode fires no `PermissionRequest` and no Notification
(measured), and a dialog answered in under about 6 s gets no Notification.

`PermissionRequest` itself is handled before any agent is touched. The prototype
does this in `apply`, right after `heard()`. It records `session.asks.push(now)`
and returns `{applied: true}`. It does not change any agent's state, tool,
activity time or `lastEventTs`. Claude fires it for asks that never show a
dialog, so nothing may block on it, and it carries no `tool_use_id` to tie it
to an agent. Whether it carries an `agent_id` is irrelevant here: the time is
recorded per session. No `tool_input` is read or kept (SEC-01).

### Rule 2: the listing ends a permission block (Esc)

This is the full rule, with each condition named:

- **Who acts.** Only a provider that declares `listingEndsPermissionBlocks`:
  Claude is `true` and Codex is `false`. The registry reads only that
  capability and the lister's translated word `screen === "at-prompt"`. The
  translation is done by Claude's lister (`claudeScreen`, `status: "idle"`).
  So CAP-02 holds: the registry contains no provider names.
- **When the poll counts.** Every discovery poll carries `observedAt`, the time
  the poll **started** (`pollInto`, reused from 96d3367).
- **What it ends.** For every agent in the session that is `blocked` with
  `blockedReason === "permission_prompt"` and `observedAt − stateSince ≥ 1 s`
  (`LISTING_SETTLE_MS`), set `blockedReason = null` and `transition(agent,
  "waiting")`.
- **What follows.** The NotifyLoop's existing retire path sends `resolved` on
  its next pulse, if the block was announced.
- **What it never does.** It never begins a block and never chooses an agent.
  A screen with nothing on it has no dialog for any agent.
- **What it leaves alone.** It does not end `agent_needs_input` or
  `worker_permission_prompt` blocks. Nobody has measured what the listing
  shows for them.

### Optional add-ons, measured but not part of the briefed candidate

- **C+busy (rule 3, clear only).** While a `permission_prompt` block stands, a
  poll begun after its date that finds any dialog on screen records
  `waitSeenAt`. Any dialog means `waiting`, whatever `waitingFor` says. A
  later poll that reads `working` ends the block as `tool-running`.

  This fixes the inherited false reminders in (iii), (v), F1-P4, R5 and S3. In
  every replay it cleared within one poll. It needs one optional agent field.

  Its risk is a `busy` read while the same dialog is still on screen. The
  listing has been measured to read `waiting` from the first poll for a Bash
  dialog. The lagging case is `AskUserQuestion`, which reads `busy` at about
  1 s. A dialog-first guard protects that case, and the replay
  `busy-risk-ask` confirms it.

  A false clear repairs itself when the next Notification arrives. M33 shows
  the one shape where it clears: a re-ask while blocked, then a `busy` read.
- **FileChanged never ends a block.** This is a one-line fix for a bug
  inherited from main, which F4-1s measures. It is not prototyped.
- **Pulse on `becameBlocked`.** Wire the daemon's existing `onBlocked` to
  `loop.pulse()`. It removes the 0 to 1 s pulse wait. Reasoned, not measured.
  It needs a re-entrance check in the loop.

---

## 2. State needed

| | New state | Persisted |
|---|---|---|
| C (lit or ref) | `SessionRecord.asks?: number[]`, pruned to 10 s. No per-agent fields. | No. Same rule as `announcedAt`. |
| C0 | None. `CAPABILITIES.*.promptNoticeAgeMs` only. | n/a |
| Rule 2 (all variants) | None. It reads `stateSince`, `blockedReason` and `observedAt`. It adds `DiscoveredSession.screen` (lister) and `reconcile({observedAt})`. | No. |
| C+busy | `AgentRecord.waitSeenAt?`, cleared by every `transition`. | No. |

## 3. Size

These are counts of non-comment lines added.

| | Registry | Elsewhere |
|---|---|---|
| **C as briefed** | About 30 lines. | `sessions.ts` adds `screen`, `claudeScreen` and `pollInto` (about 35 lines, reused from 96d3367). `cli/main.ts` uses `pollInto`. `capabilities.ts` gains one field. `PermissionRequest` touches `hooks.json`, `normalize.ts` and `event.ts` (about 15 lines). |
| **C0** | Under 25 lines. | No hook, normalizer or contract change. |
| 96d3367 (held), for comparison | 210 lines (`+572` with comments), plus 3 per-agent fields and 6 rules. | |

The prototype diff covers all variants, the switches that select them, and
comments. It is `+344/−21` across 7 files.

---

## 4. Scorecard

Each cell shows the envelopes sent, written as `kind:who@seconds`. Every cell
is **measured** with the same replay harness in all three trees, except (ix),
which is reasoned from the code. "C" is the briefed rule (`lit`); C0 and
C+busy are listed where they differ. Times are on the timeline's clock, and
pulses run every 1 s.

### Baseline behaviours

| # | Case | main 07c3935 | held 96d3367 | **C** (and variants) |
|---|---|---|---|---|
| i | Lone main Bash dialog, alert latency from the dialog becoming visible (60 runs: 3 Notification gaps × 5 poll phases × 4 pulse phases) | 10.95 / **11.45** / 11.95 s (min / median / max) | 4.7 / **5.2** / 5.45 s | 5.95 / **6.45** / 6.95 s, which is 0 to 0.95 s after the Notification. Identical in every variant. |
| i-late | User active at the terminal, so the Notification comes at the 12 s re-check | 17.2 s | 5.2 s | 17.2 s (as main: the ask is more than 10 s old). **C0: 12.2 s.** |
| ii | Esc, latency to `resolved` (15 runs: Esc at 10, 20.3 and 33.7 s × 5 phases) | never; reminders every minute until the next event | 1.0 / 3.3 / 5.7 s, ends `waiting` | **1.0 / 3.3 / 5.7 s, 15 of 15, ends `waiting`** |
| ii | Esc at 3 s, before the Notification | nothing | **false alert** `blocked@6`, then `resolved@7` | nothing |
| ii | Esc at 6.9 s, just after the Notification | `blocked@12`, `@72`, … never resolved | `blocked@6`, `resolved@12` | `blocked@7`, `resolved@12` |
| iii | Approval, short tool (approved 20 s, done 20.5 s) | `blocked@12`, `resolved@21` | `blocked@6`, `resolved@21` | `blocked@7`, `resolved@21` |
| iii | Approval, long tool (approved 20 s, done 200 s) | `blocked@12`, `@72`, `@132`, `@192`, `resolved@200` | `blocked@6`, `resolved@23` | `blocked@7`, `@67`, `@127`, `@187`, `resolved@200` (the same false reminders as main). **C+busy: `resolved@23`.** |
| iii | Approved at 7.1 s, long tool | `blocked@12` (false, already approved), then reminders | `blocked@6`, `resolved@13` | `blocked@7` (true at that moment), then false reminders to 200 s. **C+busy: `resolved@13`.** |
| iv | Auto mode (classifier approves, no ask, no Notification) | nothing | nothing | nothing |
| v | Subagent's dialog, approved 30 s, subagent then works to 200 s | `blocked:main@13`, `@73`, `@133`, `@193`, `resolved@200`: 1 alert and 3 false reminders | `blocked:sub@7`, `resolved@31` | `blocked:main@8`, `@68`, `@128`, `@188`, `resolved@200`: 1 alert, 3 false reminders, names the parent. **C+busy: `blocked:main@8`, `resolved@32`.** |
| v | Same, subagent finishes at 31 s | `blocked:main@13`, `resolved@31` | `blocked:sub@7`, `resolved@31` | `blocked:main@8`, `resolved@31` |
| v | Same, where the child's own state is shown (R3) | parent blocked; child decays to `idle` at about 30 s while its dialog is up | child blocked; parent working | as main |
| vi | Self-denied background ask alone | nothing | nothing | nothing |
| vi | Self-denied ask 0.5 to 6.3 s after a real prompt (15 runs) | never lost; alert 11.2 s after the dialog appears | never lost; 5.2 to 6.2 s | **Never lost (measured); 0 background alerts (measured).** Never taken over: by construction, only the main agent can hold a Claude `permission_prompt` block in C. C: 6.2 / 8.2 / 11.2 s (a younger ask pulls the date later, by up to 5 s, never past main). **C0 and C-ref: 6.2 s in all 15.** |
| vii | Parallel asks A and B from main (A approved 10 s, B on screen 10 to 40 s) | `blocked@22`, `resolved@41` (A never alerted: approved inside main's dwell) | `blocked@6`, `resolved@11`, `blocked@22`, `resolved@41` | `blocked@7`, `resolved@11`, `blocked@22`, `resolved@41`. **C0: B at `@17`.** |
| viii | Discovery down, Esc at 20 s | `blocked@12`, `@72`, … | `blocked@7`, `@67`, … | `blocked@7`, `@67`, …: as main, just sooner. Esc is not seen without a listing. |
| ix | Remote sessions (**reasoned**) | `RemoteDiscovery` (`src/discovery/remote.ts`) never calls `registry.reconcile`. Remote blocks are found by the remote host's own daemon, from its own local listing, and delivered over the pair (PSH-06). A host reached only over ssh has no hooks, so no blocks on any design. | same | Unchanged. A paired remote daemon running C behaves as local. |
| x | Codex: auto-reviewed ask, Esc (`Interrupt`), human approval at 40 s | nothing; `waiting`; `blocked@31`, `resolved@40` | identical | **identical.** Codex never sends `permission_request`, its `promptNoticeAgeMs` is 0, and its `listingEndsPermissionBlocks` is false. |

**G4 accounting** (dialog visible 0.8 s, approved 20 s, tool done 20.5 s;
blocked time measured to the PostToolUse):

| | blockedMs | activeMs |
|---|---|---|
| main | 13 700 | 6 800 |
| held | 20 100 | 400 |
| C | 20 100 | 400 |
| C0 | 18 700 | 1 800 |

The true dialog time is 19.2 s. Main under-counts it by about 6 s, C
over-counts by 0.4 s, and C0 under-counts by 1 s.

### Probe timelines (probes/86)

| Finding / timeline | main 07c3935 | held 96d3367 | **C** |
|---|---|---|---|
| **VR3-86-1 / F1**, S1 (parallel re-ask while A is on screen) | `blocked:main@15`, `resolved@61`, `blocked:main@72` | `blocked:main@8`, `blocked:sub@10`, **`resolved:main@10`** (false), `blocked:sub@70`, `resolved:sub@95` | `blocked:main@14`, `resolved@61`, `blocked:main@72`. **C0 and C-ref: `@10`.** No retraction exists, so no false `resolved`. |
| S1 control | `@15`, `resolved@61` | `@8`, `resolved@61` | `@10`, `resolved@61` |
| F1R V0 to V6 (skeptic variants) | all `blocked:main@15`, `resolved@61`, `blocked@72` | false `resolved:main` or alerts to SUB in V0 to V4 | all `blocked:main@10` or `@14`, `resolved@61`, `blocked@72`. Never the wrong agent, never a false `resolved`. (C+busy adds `resolved@95` once B's dialog closes.) |
| **VR3-86-2**, RX (a Notification-made block whose agent asks again) | `blocked:main@5`; main stays blocked | `blocked:main@5`, `blocked:sub@13`, **`resolved:main@13`** | `blocked:main@5`; main stays blocked |
| RY (sighting-made block, parallel re-ask) | nothing by 7 s; main blocked | `blocked:main@6`, `blocked:sub@7`, **`resolved:main@7`** | main blocked, nothing taken over. C alerts after 7 s (dated from the re-ask at 3 s). **C0 and C-ref: `blocked:main@7`.** |
| RX2 / RX3 | main blocked | sub blocked, main resolved | main blocked; no retraction |
| **VR3-86-3**, DOCS (a lone young claim) | main blocked, dated 6.4 s | main blocked | main blocked, dated 3.0 s (C0: 1.4 s). The doc must say "always the main agent". |
| **VR3-86-4 / F7** (mutation gaps) | n/a | 7 of 33 and 11 of 25 mutants survive | n/a to those rules. C's own mutation coverage has **not** been measured. |
| **VR3-86-5 / F6**, S7 and healthz (blocks counted) | S7: 1. healthz: 2, then 3. | S7: **2**. healthz: 2, then **4**. | S7: 1. healthz: 2, then 3, as main. The counter stays ingest-only: the listing never begins a block. |
| **VR3-86-6**, F3 (CHANGELOG claims) | n/a | the claims were false | "A real prompt is alerted by its Notification, and nothing moves it" is true by construction. See F2 and F3R. |
| **F2**, S2 dead=false (B shown after A) | `@12`, `resolved@21`, `@32`, `@92`, `@152` | `@6`, `resolved@21`, `@32`, … | `@7`, `resolved@21`, `@32`, `@92`, `@152`. **C0: B at `@27`.** |
| F2, S2 dead=true (plus a self-denied SUB2 ask) | as dead=false | `@6`, `resolved@21`, **`blocked:SUB2@22`, `resolved:SUB2@45`**: B is never alerted | `@8`, `resolved@21`, `@32`, `@92`, `@152`. B is alerted. (C0: `@7`, `@27`, …) |
| F2, S2c | `@13`, `resolved@61`, `@72`, … `@372`; ends blocked | `@7`, `resolved@61`, **`blocked:SUB@66` … `resolved:SUB@300`**; main `idle` with B on screen | `@8`, `resolved@61`, `@72`, … `@372`; ends blocked (C0: `@67`, …) |
| F2-noparallel | `@13`, `resolved@61`, `@77`, … | `@6`, …, `@70`, … | `@8`, `resolved@61`, `@72`, … |
| **F3R** V0, V1, V2, V2-control, V0-resend | main alerted `@12` in all | V1: SUB2 falsely alerted, main only at 50 s. **V2: main never alerted.** | main alerted `@7` or `@8` in all; no SUB2 alert |
| **F4**, S4 (dead subagent while another's dialog is up, 600 s) | SUB `idle` by 35 s, activeMs 36 900 | SUB **`thinking`** all 600 s | SUB `idle`, activeMs 36 900. `tick()` is untouched. |
| S4b (`agent_needs_input`, Esc, 1 h) | main blocked; SUB `idle`; 26 alerts | SUB `thinking` | as main |
| S4c (Codex sibling, 16 min) | `idle` | **`thinking`** | `idle` |
| F4 probes P1 to P5 | all decay | none decay | as main |
| **F5**, S5 (`agent_needs_input` during a permission block, then Esc) | `blocked@8`, `blocked@68` | **nothing** (the need is dropped) | `blocked@8`, `blocked@68`, as main |
| S5b (`agent_needs_input` first, then the permission Notification, then Esc) | `blocked@7`; stays blocked | `blocked@7`, `resolved@11` | `blocked@7`, `resolved@11`. Last reason wins, so Esc ends it. **This differs from main.** |
| R1 (a self-denied ask after main's ask, 5 timings) | `@12`, `resolved@60` | at 8 s or more, **SUB2 is falsely alerted at 6 and main delayed to 13, 18 or 45 s** | `@7`, `resolved@60` in all 5 |
| R2 | `@12` | `@5` | `@8` (C0: `@7`) |
| R3 (parent and child while the child's dialog is up) | parent blocked; child `idle` | child blocked | as main (C+busy resolves the parent at 91 s once the dialog closes) |
| R4 (`agent_needs_input` during a block, Esc) | `@11`, `@71`, …; stays blocked | `@5`, **`resolved@7`** (the need is lost) | as main |
| R5 (a stale ask, then a dialog with no ask; **the timeline has no Notification**) | nothing | `dlgAt=6`: alert from a stale claim, `resolved@37` | nothing |
| R5 with the Notification Claude would send | `@17`, `@20`, `@23`, `@41`, then false reminders after the dialog closes | `@7` or `@20`, `@23`, `@41`, then `resolved` | C as main. **C0: `@12`, `@15`, `@18`, `@37`.** C+busy resolves within one poll of the dialog closing. |
| **R6 sweep** (120 runs) | main lost 0; background alerts 0; false `resolved` 0; first alert always 12 s | lost 0; **background alerts 20; false `resolved` 20**; first alert 5 to 26 s | **lost 0; background alerts 0; false `resolved` 0.** First alert 7 / 8 / 10 s (C); **always 7 s (C0 and C-ref).** |
| F1 control, P2, P3, P4 (approved before any poll; 10 min tool; **no Notification in the timeline**) | nothing | **false alert `@5`** for a dialog approved at 4 s, in all four | nothing |
| F1-P4 with the Notification (sub's dialog 3.4 to 21 s) | `@15`, then **9 false reminders** to `resolved@600` | `blocked:main@5` (false), `blocked:sub@10`, `resolved@22` | `@10`, then **9 false reminders** to `resolved@600` (as main). **C+busy: `@10`, `resolved@22`.** |
| F3 busy path (non-blocking notifications) | nothing; `tool-running` | nothing | nothing |
| zzv-f34 F4 (FileChanged around the dialog) | ends blocked; alert `@15`. A FileChanged at 7 s **ends the block, and the dialog is never alerted.** | blocked; alert `@5` | as main, alert `@10` or `@15`. FileChanged at 7 s also loses it. |
| F4-1s (FileChanged at the real 1 s cadence) | a FileChanged at 7.5 or 9 s: **never alerted** | immune | alerted `@7`, then a **false `resolved`** at the FileChanged (8, 9 or 20 s) while the dialog is up to 60 s. **Inherited bug.** |
| M19 (Esc, then a dialog with no ask seen 3 s later; no Notification) | nothing; `tool-running` | nothing; `waiting` | as main |
| M33 (blocked, re-ask, seen, then `busy`) | blocked | blocked | blocked. **C+busy clears it to `tool-running`** (its one risk shape). |
| R1-min | `blocked:main@16` | `@7` | `@11` (sparse pulses in this probe); C0 `@7` |
| MONO (5 refute shapes, run until 7 s) | nothing by 7 s | 4 of 5 go wrong. RECLAIM: false `resolved:main`. BASE: one dialog alerted twice, main and SUB. PRE and POLLAFTERSUB: SUB alerted, not main. | main blocked in all 5, alert after 7 s (C) or **`@7` in all 5 (C0)** |
| S2b (**no Notifications in the timeline**) | nothing | `@5`, `resolved@21` | nothing |
| S2b with the Notifications | `@12`, `resolved@21`, `@34` | `@5`, `resolved@21`, `@34` | `@8`, `resolved@21`, `@34` (C0: `@7`, `@29`) |
| S3 notice=true (SUB queued behind main's approved A) | `@16`, `resolved@64` | **false `blocked:main@5`**, `blocked:sub@11`, `resolved` | `@11`, `resolved@64`. Names main; still blocked from 30 s, when SUB was approved, to 64 s. **C+busy: `resolved@32`.** |
| S3 notice=false | nothing | false `blocked:main@5` | nothing |
| S6a (discovery down) | `@12`, dated 6.4 s | `@7`, dated 0 | `@7`, dated 0 (C0: 1.4 s) |
| S6b and S6c (who a Notification with no ask blocks) | main | main, or **SUB** in the window case | main |
| S6d (masked: `waiting` / "input needed" throughout) | `@12`, `resolved@30`, `@41` | `@7`, `resolved@30`, `@41` | `@7`, `resolved@30`, `@41` (C0: `@36`). Esc there is not seen: as main. |
| S8 (main's A on screen, SUB queued) | `@12`, `resolved@21` | **`blocked:sub@6`** (wrong: main's dialog was up), `resolved@41` | `blocked:main@7` (the right agent), `resolved@21` |

**Probe failure modes that survive in C.** None of the held design's survive.
The four below are main's, and they still survive. All four are measured.

1. A subagent's dialog, or a long approved tool, keeps the parent blocked and
   reminding until the parent's next event: v, iii, F1-P4, R5 with the
   Notification, S3 and S2c.
2. The alert names the parent. The child decays to `idle` while its dialog is
   up (R3).
3. A FileChanged ends a permission block (F4, F4-1s). C narrows this from a
   lost alert to an alert followed by a false `resolved`.
4. `agent_needs_input` and other non-permission blocks are not ended by Esc
   (S4b, R4).

C+busy fixes the first. The one-line FileChanged fix would close the third.

---

## 5. What C loses against the ~5 s target

- **Measured over 60 runs.** C alerts 5.95 to 6.95 s after the dialog becomes
  visible (median 6.45 s). Against a 5 s target that is +0.95 to +1.95 s
  (+1.45 s median). Against the held design, which alerts from the listing at
  a median of 5.2 s, it is +1.25 s median.
- **What sets the floor.** Claude's own Notification gate comes 5.8 to 6.2 s
  after the dialog is visible, which is 6.2 to 6.6 s after
  `PermissionRequest`. On top of that, the loop waits 0 to 1 s for its next
  pulse. Firing a pulse on `becameBlocked` would remove that wait, giving
  about 5.8 to 6.2 s (reasoned).
- **The tail is worse when the user is active at the Claude terminal.** Claude
  then re-checks every 6 s, so the Notification can come at 12 or 18 s:
  - C as briefed (the ask is more than 10 s old by then): 17.2 s, the same as
    main.
  - C0: 12.2 s.
  - The held design: 5.2 s.

  A user typing in that terminal is usually looking at it, so the cost is
  small in practice. It is still a real gap against the held design.
- **What C gains in return.** A dialog dismissed or answered within about 6 s
  gets no Notification, so C never alerts it. The held design measurably did
  alert those: F1 control, a false `@5` for a dialog approved at 4 s; Esc at
  3 s, a false `@6`.

## 6. Risks

1. **Inherited from main: approved dialogs keep reminding.** After a
   subagent's dialog is approved, the parent stays blocked until the parent's
   next event. Measured: 3 false reminders over 200 s in (v), and 9 over
   10 min in F1-P4. The same applies to a long approved main-agent tool. The
   two briefed rules do not fix it; C+busy does.
2. **Inherited from main: wrong agent named, and a FileChanged ends a block.**
   The parent is named for a subagent's dialog, and the child shows `idle`.
   After the alert, a FileChanged sends a false `resolved` while the dialog is
   still up (F4-1s).
3. **A younger ask delays the briefed rule.** Under C as briefed, a younger
   ask pulls the date later: a background ask that denies itself, a parallel
   re-ask, or another agent's ask. That costs up to 5 s, with a median of 2 s
   in (vi). It is never later than main. C0 and C-ref remove it.
4. **The briefed rule puts a hook in front of every dialog.** Claude awaits
   `PermissionRequest` hooks before showing a dialog, and the timeout is 5 s.
   A wedged daemon delays every dialog by up to 5 s; a stopped daemon fails
   fast. The response body `{ok, applied}` carries no decision, so NG4 holds.
   C0 subscribes to nothing new.
5. **The Esc rule depends on the listing.** It trusts `claude agents --json`
   to read `idle` with nothing on screen (measured on 2.1.291 and 2.1.312). If
   the listing format changes, Esc goes back to main's behaviour, not worse.
   In a masked session (`waiting` / "input needed" forever) Esc is never seen,
   as on main. A slow poll that began before the dialog opened and lands after
   the Notification could, in theory, end a block. The `observedAt ≥
   stateSince + 1 s` check and the clamp to the agent's own state change make
   that need a poll lasting more than about 6 s. The lister's timeout is 5 s.
6. **C0 depends on Claude's 6 s Notification threshold.** That value comes
   from the 2.1.312 binary and agrees with the 6.2 to 6.6 s measured. If a
   future Claude notified sooner, C0 would alert sooner. It would still never
   alert an auto-answered ask, because those produce no Notification. Pin the
   threshold with a capture test.

   C0 also changes **4 existing assertions** in `registry.test.ts` and
   `announced.test.ts`. They model a Notification less than 5 s after
   PreToolUse, which Claude never sends, and would need new expected dates.
   C as briefed, C-ref and C+busy pass main's suite unchanged: 1349 of 1349,
   excluding `observability.test.ts`, which needs a built `dist/` and fails
   the same way on main.
7. **Last reason wins (S5b).** An `agent_needs_input` block that a later
   `permission_prompt` overwrote is now ended by Esc. On main it stays
   blocked. What `agent_needs_input` means is unmeasured.
8. **Measured offline only.** No live Claude session was run; every result is
   a fake-clock replay of the probes' timelines and the brief's measured
   timings. C's own rules have not been mutation-tested.

## 7. User-visible trade-offs

- A permission prompt alerts about 5 s sooner than today: about 6.5 s after it
  appears, against about 11.5 s. That is about 1.3 s slower than the held
  design.
- Pressing Esc at a prompt now clears the alert, with a `resolved` sent within
  about 1 to 6 s. Today it reminds every minute until the agent does something
  else.
- A prompt you answer 6 to 7 s in may ping once, then resolve. Today it would
  have stayed quiet if answered before about 11.5 s. A prompt answered or
  dismissed in under about 6 s never pings, unlike the held design.
- The alert still names the session's main agent, not the subagent whose
  prompt it is. "Take me there" still lands on the right pane.
- After you approve a subagent's prompt, or a long-running command, astir
  keeps reminding until the agent's next event, as it does today. Adopting
  C+busy would fix this.
- Background agents that deny themselves never produce an alert (0 of 120 in
  R6, against 20 of 120 for the held design), and never take over a real
  prompt.
- If the user is typing in that Claude terminal while the prompt is up, the
  alert can come at about 12 s (C0) or about 17 s (briefed rule).
- With discovery down, or in a masked session, Esc is not seen, as today.

## 8. Prototype and how to reproduce

The prototype worktree was at `/home/dev/astir-d86-minimal`: 280b316 with
`src`, `hooks` and `test` reverted to 07c3935, then C applied. It has been
removed. The diff is `minimal.diff` in this folder, against 07c3935 for `src`
and `hooks`, with the replay harness appended.

Switches (prototype only; not part of the design):

| Switch | Values |
|---|---|
| `D86_DATING` | `lit` (default, the briefed rule), `ref`, `c0`, or `none` (rule 2 only) |
| `D86_BUSY` | `1` turns on C+busy |
| `D86_IDLE` | `0` turns off rule 2 |

The harness is `zz-d86-replay.test.ts` in this folder. Copy it into `test/` of
any tree: 07c3935 plus the fixture
`test/fixtures/claude/permission-request.json`, 96d3367, or C. Then run:

```
D86_OUT=<file> npx vitest run test/zz-d86-replay.test.ts
```

It writes one JSON line per case. The raw results are in `runs/<label>.jsonl`
for `main`, `held`, `C-lit`, `C-ref`, `C0`, `C-none`, `C-lit-busy` and
`C0-busy`. Compare them with:

```
python3 compare.py <dir> <labels> [ids]
```

The harness reproduces the README's recorded outputs exactly, for both main
and held: S1, S2 dead=true, S2c, S4, S5, RX and RY.

The spec has no §14; its sections end at §12, the decision record.
