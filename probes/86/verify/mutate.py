#!/usr/bin/env python3
"""Mutation runner for the #86 lane. Runs only in /home/dev/astir-vr3-86v."""
import re
import subprocess
import sys

W = "/home/dev/astir-vr3-86v"
OUT = "/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-86v/mutants.log"
REL = open("/tmp/claude-1000/-home-dev-repos-astir/d8458719-ef7f-472f-be54-5616006a1f7c/scratchpad/vr3-86v/rel.txt").read().split()
FAST = ["test/claude-permission.test.ts", "test/registry.test.ts", "test/discovery.test.ts"]

R = "src/model/registry.ts"
S = "src/discovery/sessions.ts"

MUTANTS = [
    # --- last fix round ---
    ("N01 NOTICE_MIN_AGE_MS = 0", R, "const NOTICE_MIN_AGE_MS = 5_000;", "const NOTICE_MIN_AGE_MS = 0;"),
    ("N02 NOTICE_MIN_AGE_MS = 7_000", R, "const NOTICE_MIN_AGE_MS = 5_000;", "const NOTICE_MIN_AGE_MS = 7_000;"),
    ("N03 retractYoungerBlocks no-op", R,
     "private retractYoungerBlocks(session: SessionRecord, owner: AgentRecord): void {\n",
     "private retractYoungerBlocks(session: SessionRecord, owner: AgentRecord): void {\n    if (owner) return;\n"),
    ("N04 retract boundary >= -> >", R,
     "if (a.dialogSince === null || now - a.dialogSince >= NOTICE_MIN_AGE_MS) continue;",
     "if (a.dialogSince === null || now - a.dialogSince > NOTICE_MIN_AGE_MS) continue;"),
    ("N05 retract leaves claim unheld", R,
     "      a.dialogHeldAt = now;\n      a.acknowledgedAt = null;",
     "      a.acknowledgedAt = null;"),
    ("N06 retract keeps announcedAt", R,
     "      a.acknowledgedAt = null;\n      a.announcedAt = null;\n    }\n  }",
     "      a.acknowledgedAt = null;\n    }\n  }"),
    ("N07 retract any reason", R,
     "if (a === owner || !HUMAN_BLOCKING.has(a.state) || a.blockedReason !== \"permission_prompt\") continue;",
     "if (a === owner || !HUMAN_BLOCKING.has(a.state)) continue;"),
    ("N08 claimLapsed ignores dialogHeldAt", R,
     "return at - Math.max(a.dialogSince, a.dialogHeldAt ?? a.dialogSince) >= CLAIM_WINDOW_MS;",
     "return at - a.dialogSince >= CLAIM_WINDOW_MS;"),
    ("N09 settle: passed-over claims not held", R,
     "if (a !== newest) a.dialogHeldAt = Math.max(a.dialogHeldAt ?? observedAt, observedAt);",
     "if (a !== newest && a === null) a.dialogHeldAt = observedAt;"),
    ("N10 settle: held overwritten not max", R,
     "if (a !== newest) a.dialogHeldAt = Math.max(a.dialogHeldAt ?? observedAt, observedAt);",
     "if (a !== newest) a.dialogHeldAt = observedAt;"),
    ("N11 settle: standing block ignored (newest still blocked)", R,
     "if (standing.length === 0) {", "if (standing.length >= 0) {"),
    ("N12 R4 early return removed", R,
     "    if (\n      blocked &&\n      blocking &&\n      LISTING_ENDS.has(agent.blockedReason ?? \"\") &&",
     "    if (\n      false &&\n      blocking &&\n      LISTING_ENDS.has(agent.blockedReason ?? \"\") &&"),
    ("N13 tick: no waitingOnHuman skip", R,
     "if (providerBusy || waitingOnHuman) continue;", "if (providerBusy) continue;"),
    ("N14 transition: no blocks++", R,
     "if (!HUMAN_BLOCKING.has(agent.state) && HUMAN_BLOCKING.has(next)) this.blocks++;", ""),
    ("N15 claim does not reset dialogHeldAt", R,
     "      agent.dialogSince = this.nowMs();\n      agent.dialogHeldAt = null;\n",
     "      agent.dialogSince = this.nowMs();\n"),
    ("N16 claudeScreen: any waiting is a permission dialog", S,
     "return waitingFor === CLAUDE_PERMISSION_DIALOG ? \"permission-dialog\" : \"other-dialog\";",
     "return \"permission-dialog\";"),
    ("N17 claudeScreen: shell not at-prompt", S,
     "const CLAUDE_AT_PROMPT = new Set([\"idle\", \"shell\"]);", "const CLAUDE_AT_PROMPT = new Set([\"idle\"]);"),
    ("N18 parseAgentsJson drops screen", S,
     "      ...(screen === undefined ? {} : { screen }),\n", ""),
    ("N19 pollInto reads clock after answer", S,
     "  const observedAt = now();\n  return lister()\n    .then((found) => {\n",
     "  return lister()\n    .then((found) => {\n      const observedAt = now();\n"),
    ("N20 claudeScreen: busy not working", S,
     "const CLAUDE_WORKING = new Set([\"busy\", \"running\", \"working\"]);",
     "const CLAUDE_WORKING = new Set([\"running\", \"working\"]);"),
    ("N21 LISTING_SETTLE_MS = 0", R, "const LISTING_SETTLE_MS = 1_000;", "const LISTING_SETTLE_MS = 0;"),
    ("N22 non-progress early return removed (FileChanged ends block)", R,
     "if ((blocked || agent.dialogSince !== null) && !OWN_PROGRESS.has(ev.kind) && !blocking) {",
     "if (false && (blocked || agent.dialogSince !== null) && !OWN_PROGRESS.has(ev.kind) && !blocking) {"),
    ("N23 settle claims include those begun after poll", R,
     "const claims = open.filter((a) => (a.dialogSince ?? observedAt) <= observedAt);",
     "const claims = open;"),
    ("N24 listing ends any blocking kind", R,
     "const LISTING_ENDS = new Set([\"permission_prompt\"]);",
     "const LISTING_ENDS = new Set([\"permission_prompt\", \"agent_needs_input\", \"worker_permission_prompt\"]);"),
    # --- previous round's survivors, re-applied ---
    ("M02 attribution reroutes explicit agent ids", R,
     "if (event.notificationKind !== \"permission_prompt\" || event.agentId !== event.sessionId) return event;",
     "if (event.notificationKind !== \"permission_prompt\") return event;"),
    ("M03 rerouted event keeps main identity", R,
     "      agentId: owner.id,\n      agentType: null,\n      parentAgentId: null,\n      parentSource: null,\n      description: null,\n",
     "      agentId: owner.id,\n"),
    ("M05 noticeOwner: no blocked tie preference", R,
     "if (best === null || since > best || (since === best && isBlocked)) newest = a;",
     "if (best === null || since > best) newest = a;"),
    ("M06 noticeOwner ignores window", R,
     "      if (!isBlocked && claimLapsed(a, at)) continue;\n", ""),
    ("M14 sighted for any blocking kind", R,
     "const sighted = becameBlocked && ev.notificationKind === \"permission_prompt\" ? agent.dialogSince : null;",
     "const sighted = becameBlocked ? agent.dialogSince : null;"),
    ("M15 non-claim block keeps stale claim", R,
     "if (OWN_PROGRESS.has(ev.kind) || (becameBlocked && sighted === null)) agent.dialogSince = null;",
     "if (OWN_PROGRESS.has(ev.kind)) agent.dialogSince = null;"),
    ("M19 transition keeps claim after block ends", R,
     "    if (HUMAN_BLOCKING.has(agent.state)) agent.dialogSince = null;\n    agent.dialogSeenAt = null;\n",
     "    agent.dialogSeenAt = null;\n"),
    ("M24 noticeOwner window > boundary", R,
     "      if (!isBlocked && claimLapsed(a, at)) continue;\n",
     "      if (!isBlocked && claimLapsed(a, at - 1)) continue;\n"),
    ("M33 dialogStart = stateSince only", R,
     "const dialogStart = (a: AgentRecord): number => Math.max(a.stateSince, a.dialogSince ?? a.stateSince);",
     "const dialogStart = (a: AgentRecord): number => a.stateSince;"),
]


def run(files):
    p = subprocess.run(["npx", "vitest", "run", *files], cwd=W, capture_output=True, text=True, timeout=900)
    out = p.stdout + p.stderr
    m = re.search(r"Tests\s+(.*)", out)
    fails = sorted(set(re.findall(r"FAIL\s+(test/\S+ > [^\n]+)", out)))
    return p.returncode, (m.group(1).strip() if m else "no summary"), fails


def main():
    only = set(sys.argv[1:])
    with open(OUT, "a") as log:
        for name, path, old, new in MUTANTS:
            if only and name.split()[0] not in only:
                continue
            full = f"{W}/{path}"
            src = open(full).read()
            n = src.count(old)
            if n != 1:
                line = f"{name}: NOT APPLIED (pattern count {n})"
                print(line, flush=True)
                log.write(line + "\n")
                continue
            open(full, "w").write(src.replace(old, new))
            try:
                rc, summ, fails = run(FAST)
                stage = "fast"
                if rc == 0:
                    rc, summ, fails = run(REL)
                    stage = "full22"
            finally:
                subprocess.run(["git", "checkout", "--", path], cwd=W, check=True)
            verdict = "KILLED" if rc != 0 else "SURVIVED"
            line = f"{name}: {verdict} [{stage}] | {summ} | {fails[:4]}"
            print(line, flush=True)
            log.write(line + "\n")
            log.flush()
    st = subprocess.run(["git", "status", "--short", "--", "src"], cwd=W, capture_output=True, text=True).stdout
    print("src clean after run:", st.strip() == "", flush=True)


if __name__ == "__main__":
    main()
