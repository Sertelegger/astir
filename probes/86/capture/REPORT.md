
# #86 capture report: Claude Code 2.1.322, measured against C+ and B

Inputs: five lanes. Probe sessions: listing 2, hooks 3, queue 1, survey 1, binary 0, so 7 in all, every one on claude-haiku-5-5 in default mode, apart from 2 that started in dontAsk.
Folder: probes/86/capture/
Every time is hook receipt time, which includes 20-40 ms of python start-up. "Reasoned" means the design's rules were read against the live timelines but not run in a harness.

## 0. SEC-01 audit
- **Scope.** All 120 files were scanned byte by byte, binary extracts included. I looked for home paths, emails, tokens, transcript_path values, tool_input objects and prompt values.
- **jsonl records.** Every record holds metadata only: times, event names, key names, ids, sha256, byte counts, status and waitingFor words, and synthetic cap-* labels.
  - tool_input, tool_response, message, prompt, last_assistant_message and transcript_path appear only as key names, never with values.
- **Deleted: binary/tok.mjs.** It imported acorn by an absolute path into another of the user's repos, which is a path outside the work dirs. As a result the binary lane's token diff cannot be re-run as it stands. Its outputs (*.tok, askdiff.txt) are kept.
- **Kept.** The rule: paths the task itself names are kept, and code shipped in the Claude binary is not user content.
  - Scripts naming ~/.claude-nv (the brief's CLAUDE_CONFIG_DIR) and ~/.local/share/claude/versions/ (the brief's binary location).
  - Code and changelog extracts from the Claude binary in binary/. None of it is user content.
  - Synthetic files (cap-KKK, cap-R1, "scratch line cap-x2", empty cap-*).
- **Outside cap86, reported and not touched.**
  - Two 7-byte synthetic plan files in ~/.claude-nv/plans/ written by listing-lane probes.
  - The probe sessions' transcripts under ~/.claude-nv/projects/ (the listing lane named two: 1562313e-..., 66d7f2dc-...).

## 1. Cross-check: live lanes against the binary lane
- **Notification timer: agree.**
  - Binary: 6 s ticks from mount; fires when now - max(lastInteraction, mount) >= 6000; once per mount.
  - Live: PermissionRequest to Notification 5983-6125 ms (n=53). An inert key gives the first qualifying tick: 12016 and 12043 ms (n=2), 18020 ms (n=1).
  - Live settles the survey lane's open question: the timer re-checks on the 6 s grid after a key.
- **Buried dialogs notify: agree.** Binary: iIe, once per request id, since 2.1.312. Live: a hidden ask notifies at its own PermissionRequest + 5996-6083 ms (n=12).
- **A revealed dialog notifies again: disagree on timing; live wins.**
  - Binary: a remount resets `sent`, which predicts reveal + 6 s.
  - Live, re-derived from raw: reveal + 11932-12085 ms (n=7, queue lane), and reveal + 5980 ms (n=1, hooks lane UUU).
  - No Notification at +6 s in 10 of 11 reveals held longer than 6 s. ~12 s is usual and 6 s is possible. No mechanism is claimed.
- **PermissionRequest hook is a racer, not awaited: agree.**
  - Binary: the hook runs as a racer in the TUI. Some subagent contexts (awaitAutomatedChecksBeforeDialog) do await it; no lane observed one.
  - Live (my derivation from listing/statusfile.jsonl): the session status flips to waiting 1-45 ms BEFORE the hook is received (n=20). The control with no PermissionRequest hook registered flipped 13-28 ms after PreToolUse (n=6).
  - So DESIGN §4 reason 2 ("Claude awaits that hook before every dialog") is wrong for every dialog measured.
- **agent_id and tool_use_id fields: agree.**
  - Subagent PermissionRequest carries agent_id 18/18.
  - PermissionRequest carries tool_use_id 0/70.
  - permission_prompt Notification carries agent_id 0/69.
- **FIFO: agree.**
  - Binary: h() inserts by askOrder. "under" goes to the bottom only when another non-user dialog is open.
  - Live: oldest on top in 10 discriminating pairs, including a main ask raised behind an async subagent's ask (n=2), plus 2 consistent pairs from the hooks lane.
- **Plain No on main = Esc: agree.** Binary: H6r aborts when there is no feedback and the asker is not a subagent. Live: no hook, listing idle (n=1).
- **Esc at a subagent dialog: partly disagree; live wins.**
  - Binary: Esc calls cancelAndAbort(undefined, true).
  - Live, background subagent: the agent's turn continues, PostToolBatch lists the denied call, then SubagentStop (n=5).
  - Live, foreground web-fetch agent: no hook for the subagent's call; the parent gets PostToolUseFailure(Agent) (n=1).
  - The binary read does not cover background agents.
- **PostToolBatch: agree.** Fires per assistant message, is skipped on abort, and lists denied calls when the turn continues.
- **waitingFor comes from the dialog-kind table: agree.**
  - AskUserQuestion read "input needed" (n=4+1); elicitation read "input needed" (n=2). Bash, Edit, Write, WebFetch, MCP and ExitPlanMode read "permission prompt" (n=20).
  - B's UO() mechanism is refuted; the outcome is the same.
- **AskUserQuestion busy lag: agree there is none.** Binary: no code path for one. Live: 0 busy readings (n=5).
- **status null.** Seen in 4 polls, each 192-608 ms before SessionStart. The binary mapping is not contradicted: the sidecar has no status yet.

Conflicts between live lanes, re-derived from raw:
- **Foreground subagents do occur.** In the listing lane's web-fetch runs, PostToolUse(Agent) came 13.8 s after PreToolUse(Agent), after the subagent's own PostToolBatch (n=2).
  - general-purpose Agent launches all ran in the background: 17/17 (hooks 6, queue 11).
  - The listing recorder registers both SubagentStart and SubagentStop, yet the web-fetch agents fired neither (n=2).
- **PostToolUseFailure does fire.** It came once: the parent's Agent call, when Esc was pressed at a foreground subagent's dialog. Hooks and queue saw 0.
- **PostToolBatch count.** The queue lane wrote "n=20 batches"; the raw file has 26.

## 2. C+'s checklist (DESIGN §8)

### 1. Notification timing and the lastInteraction reset: CONFIRMED
- PermissionRequest to Notification 5983-6125 ms (n=53). Status flip to Notification 6018-6085 ms (n=21).
- One Notification per dialog mount.
- A key moves the Notification to the first 6 s tick at least 6 s after it: 12.0 s for keys at 3.2 s and 5.2 s; 18.0 s for keys at 3 s and 9 s (n=3).
- AskUserQuestion's Notification is permission_prompt (n=5).
- The invariant 5000 <= min 5983 holds, with a 983 ms margin.
- The brief's 6.2-6.6 s is now 6.0-6.1 s.

### 2. Listing after an answer, across dialog types: CONFIRMED for every type tested
- **Esc on main:** the first poll that returned after the key read idle, 20/20. Types: Bash, Read, Edit, Write, AskUserQuestion, MCP tool, ExitPlanMode; plain No is counted with Esc.
  - The session file read idle 75-115 ms after Esc (n=13). No hook fires.
- **Approve:** the first poll had left waiting 11/11. It read busy 7 times and idle 4; every idle came after Stop.
  - The session file read busy 17-112 ms after the key.
  - Fast tools stay busy only 761-2777 ms (n=9).
- **Exceptions:**
  - Esc at a subagent dialog reads busy, then idle (n=6).
  - Esc on main with a background agent's ask queued keeps reading waiting (n=2). That is correct: a dialog is still up.
  - WebFetch was measured only as a subagent dialog.

### 3. Listing busy after the Notification (sizes the settle): REFUTED on 2.1.322
- 0 busy polls between the Notification and the key for every dialog (n=27): AskUserQuestion 5, ExitPlanMode 3, elicitation 2, others 17.
- The status flips to waiting 13-60 ms after PreToolUse (n=26). AskUserQuestion reads "input needed" from the start.
- Not measured on 2.1.291/2.1.312.

### 4. The "input needed" sessions: ANSWERED
- Fresh census, n=6 sessions: idle 3, busy 2, waiting 1.
- The waiting/"input needed" session was a pending AskUserQuestion, open for 2005 s.
- Static table: "input needed" means AskUserQuestion, an MCP elicitation (even one queued behind the top dialog) or it2_setup.
- So a "masked" session has a question or elicitation open. It is not a stuck state.

### 5. The listing under agent_needs_input: OPEN
- Not measured. It needs agent view plus a --bg session.
- Static: the agents board sends it about another session, or it2_setup or auto-mode dialogs send it.
- Keep main's rule (Q4a).

### 6. D-only facts: CONFIRMED, apart from two tools
- PostToolUse input digest equals PreToolUse's 75/78. The 3 that differ are AskUserQuestion 2/2 and ExitPlanMode 1/1, where answers or the plan are added.
- Subagent PermissionRequest carries agent_id 18/18.

### Also measured, and bearing on C+
- **Dialog timing.** The dialog is on screen -9 to +244 ms around PermissionRequest receipt (n=45). PermissionRequest comes 28-181 ms after PreToolUse (n=70). So the dialog appears about 0.1-0.3 s after PreToolUse, not 0.8 s.
- **Listing poll cost.** n=3730 polls: median 484-612 ms by lane, p99 about 0.8 s, max 3.6 s.
  - The state is read near the end of the poll: polls begun 34-610 ms before an event already showed it.
  - The daemon polls every 5 s (src/cli/main.ts at 07c3935). The judge's harness modelled 300 ms per poll.
- **Non-tool dialogs send permission_prompt** (static: plan, goal, sandbox, Session paused, managed settings). C+ blocks on them.
  - Plan dialogs cleared on the listing: Esc read idle (n=3) and approve read idle (n=1).
- **MCP elicitation never alerts.** It sends elicitation_dialog at 6019-6021 ms (n=2). astir maps that to "other", so it never alerts on main, C+ or B.

## 3. B's unverified facts

### 1. PostToolBatch live: CONFIRMED
- 65 batches and 85 calls (listing 22/24, hooks 17/21, queue 26/40). It registered from --settings with no error.
- has_response is true 85/85. Every tool_use_id matches a PreToolUse, 85/85.
- The input digest matches 83/85. The 2 that differ are main's Agent calls, probably forced into the background by Claude.
- It fires 30-250 ms after the last PostToolUse.
- Skipped on main Esc and on main plain No.
- Fires for:
  - a feedback denial (n=2; denied call listed, 432 B);
  - a background agent's Esc or No (n=5, 214 B);
  - dontAsk (n=2, 729 B).
- A foreground subagent's call is in no batch after Esc (n=1).
- Body size against the 1 MiB limit is unmeasured. It exists in 2.1.312 (static read); the minimum version is unknown.

### 2. Subagent agent_id: CONFIRMED
- PermissionRequest carries it 18/18. The subagent's PostToolUse, PostToolBatch and SubagentStop also carry it.
- The Notification carries none (0/69).
- PermissionRequest has no tool_use_id (0/70).

### 3. tool_input identity: CONFIRMED
- The PermissionRequest digest equals the latest preceding PreToolUse of the same session, agent and tool, 70/70.
- Concurrent asks had distinct digests.
- PostToolUse 75/78 (AskUserQuestion and ExitPlanMode differ). PostToolBatch 83/85.

### 4. FIFO order: CONFIRMED at depth 2
- Oldest on top in 10 discriminating pairs plus 2 consistent pairs.
- **Main's parallel Bash asks never queue.** The second PreToolUse fires only after the first PostToolUse (n=3). Only Read-type asks and cross-agent asks queue.
- Not tested: depth > 2, the "under" exception, auto-deny on top, teammates.

### 5. Queued-dialog Notification timing: REFUTES R5
- **Buried asks.** A buried ask notifies at its own PermissionRequest + 5996-6083 ms while the head is on screen (n=12).
  - 7 of the 12 had a different agent's dialog on screen.
  - A key within 6 s suppresses it (n=3).
  - So a queue of 2 left alone gives 2 Notifications with one dialog visible.
- **Revealed dialogs.** A revealed dialog notifies again at reveal + 11932-12085 ms (n=7) or + 5980 ms (n=1). One queue of 2 held for 20 s produced 3 Notifications.
- **Effect on R5 (reasoned).** R5 assumes one Notification per mount, that a queued ask fits any time, and that asks ahead of the winner leave the queue.
  - At the buried ask's Notification, R5 would retire the head that is still on screen and name the queued ask's agent: wrong in the 7 cross-agent cases.
  - The post-reveal Notification fits no ask, so it becomes a notice on main.

### 6. Self-denied ask path: NOT PRODUCED LIVE (0 in 7 sessions)
- Background agents in default mode showed real dialogs, 16/16.
- dontAsk is a different path: no PermissionRequest, no PermissionDenied, PostToolBatch only, and the listing never reads waiting (n=2).
- Binary: the shouldAvoidPermissionPrompts chain is unchanged (PermissionRequest hooks run, then deny).
- New in 2.1.319: denyInsteadOfPrompting, where some paths skip the PermissionRequest. It is not set here.
- So the R6 and R1-rev sweeps model a path no lane could trigger. It is neither confirmed nor refuted.

### Also refuted for B
- **R6's "Esc aborts every queued dialog".** A background agent's queued dialog survives a main Esc, and the listing keeps reading waiting until it is answered: 30 s and 24 s (n=2).
  - Main's Esc'd head gets no exit, so B names main for the subagent's dialog (reasoned).
- **(vii) "parallel asks queue"** does not hold for Bash.
- **SubagentStart and SubagentStop as brackets.** 54 type-less SubagentStops with unannounced ids came after main Stops, probably from a plugin's hook agent. web-fetch agents send neither event.

## 4. What this means for C+
- **Begin and dating hold.**
  - N - 5 s dates the block about 1.0-1.1 s after the dialog appeared.
  - The alert lands about 6.0 s after the dialog, plus at most one 1 s pulse.
  - When the user is typing, about 12 or 18 s.
- **Esc (rule 4) holds** (20/20). **Answered (rule 5) holds** (11/11).
  - At the 5 s cadence most fast-tool approvals will read idle, and rule 4 clears them to "waiting".
- **The 2 s settle** is not needed on 2.1.322 (0 busy in 27 dialogs).
  - At a 5 s cadence it costs a poll only when the answer comes within 2 s of the Notification.
  - It is cheap insurance for older builds.
- **RULE CHANGE: rule 6 lets main's `stop` end the block** (reasoned from cplus.diff and 07c3935's nextState, not run).
  - Background agents are the default (17/17 general-purpose launches), and main's turn Stops while their dialogs are up.
  - Live, after the Notification had begun a block, with the listing reading waiting throughout: n=4 (queue SUB2, SUB6, SUB8; hooks OOO).
  - C+ sends `resolved` with the dialog on screen. 2 would re-alert 9.5 and 8.2 s later via the post-reveal Notification; 2 never would (answered 7.3 and 2.4 s later).
  - Fix: while the listing is informative (<= 12 s) and reads a dialog, hold `stop` as rule 6 holds pre_tool and post_tool. UserPromptSubmit is unmapped in astir, so it needs no change.
  - This is a background-agent form of DESIGN's fan-out timeline, which C+ passes only with foreground subagents.
- **Residual flicker (reasoned, not run).** A poll can read busy in the 179-281 ms gap between two serial Bash dialogs (1 of 2 at 1 s polling).
  - With the last sighting at least 2 s old, rule 5 then clears falsely.
  - The next dialog re-alerts about 6 s after it mounts (5943 and 6009 ms measured).
  - Estimated at about 4-6% of serial pairs at a 5 s cadence. It is not a loss.
- **"input needed" degrades the block after 12 s.** The prototype's informativeAt ignores other-dialog, so an AskUserQuestion block falls to degraded mode (rule 7) after 12 s.
  - That is harmless unless background-agent turns arrive.
  - Fix: count "input needed" as informative while a permission_prompt block is live.
- **One argument is gone.** "No extra await in the dialog path" (§4 reason 2) is gone, because the hook is a racer. C+ keeps: no new hooks, no attribution, about a third of the code.

## 5. What this means for B
- **Now on live evidence:**
  - PostToolBatch: it exists, has the right shape, lists denials when the turn continues, and is skipped on main abort.
  - agent_id on subagent PermissionRequests.
  - Digest pairing, 70/70.
  - FIFO at depth 2.
  - Plain No = Esc on main, retired by the listing (R6).
  - Exact exits for feedback denials and background-agent denials.
- **No longer stands:**
  - R5 (buried and post-reveal Notifications).
  - R6's Esc note (background asks survive).
  - (vii) for Bash.
  - The self-deny motivation for the R6 and R1-rev sweeps (0 live).
  - SubagentStart and SubagentStop as brackets.
- **The C+ `stop` failure should not apply to B** (reasoned, not run). Main's Stop closes only main's asks.
- **Residual changes:**
  - R5 must time every Notification against each ask's own claim (claimAt + 6k s, queued or not), with a second window for the remount Notification, and must stop retiring asks ahead of the winner.
  - R6 needs a rule for a stale head when another agent's ask is behind it.
  - Re-run every scorecard row that rests on R5: S3 notice=true, S8, RY, fan-out, close-claims, R1-rev.
  - The body-size limit and the version floor are still open.
- **The payoff is unchanged.** B's only gain over C+ is naming the subagent, and focus is per pane.

## 6. Not measured
- Claude 2.1.291/2.1.312 live, so the AskUserQuestion lag on older builds.
- The listing under agent_needs_input.
- WebFetch from the main agent (not in the tool list here).
- Queues deeper than 2; "under"; auto mode and PermissionDenied.
- A live self-denied ask; denyInsteadOfPrompting.
- PostToolBatch body size and its minimum version.
- The 10 s PostToolUse grace after an interrupt.
- idle_prompt after Esc: none in 118 s (n=1) and none in 290 s (n=1).
- n=1 only: main plain No, foreground-subagent Esc, the 6 s post-reveal Notification, Edit, Write, MCP and plan approve.