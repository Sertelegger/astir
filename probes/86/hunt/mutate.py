import subprocess, sys, json
WT = "/home/dev/astir-vr3-p86"
F = f"{WT}/src/model/registry.ts"
M = [
 # rule a: held claims
 ("A1 claimLapsed ignores dialogHeldAt", "a.dialogHeldAt ?? a.dialogSince) >= CLAIM_WINDOW_MS", "a.dialogSince) >= CLAIM_WINDOW_MS"),
 ("A2 sightings never hold", "        if (a !== newest) a.dialogHeldAt = Math.max(a.dialogHeldAt ?? observedAt, observedAt);", "        void a;"),
 ("A3 hold only when no standing block", "        if (a !== newest) a.dialogHeldAt =", "        if (a !== newest && standing.length === 0) a.dialogHeldAt ="),
 ("A4 hold takes latest-landing poll, not latest-begun", "a.dialogHeldAt = Math.max(a.dialogHeldAt ?? observedAt, observedAt);", "a.dialogHeldAt = observedAt;"),
 ("A5 retract does not hold", "      a.dialogHeldAt = now;\n", "\n"),
 ("A6 new claim keeps old hold", "      agent.dialogHeldAt = null;\n", "\n"),
 # rule b: NOTICE_MIN_AGE + retract
 ("B1 NOTICE_MIN_AGE_MS=0", "const NOTICE_MIN_AGE_MS = 5_000;", "const NOTICE_MIN_AGE_MS = 0;"),
 ("B2 NOTICE_MIN_AGE_MS=7000", "const NOTICE_MIN_AGE_MS = 5_000;", "const NOTICE_MIN_AGE_MS = 7_000;"),
 ("B3 no retract call", "if (ev.notificationKind === \"permission_prompt\") this.retractYoungerBlocks(session, agent);", ""),
 ("B4 retract drops the claim instead of holding", "      a.dialogHeldAt = now;\n", "      a.dialogSince = null;\n"),
 ("B5 retract keyed on stateSince (candidate fix)", "now - a.dialogSince >= NOTICE_MIN_AGE_MS) continue;", "now - a.stateSince >= NOTICE_MIN_AGE_MS) continue;"),
 ("B6 noticeOwner ignores min age", "if (since === null || at - since < NOTICE_MIN_AGE_MS) continue;", "if (since === null) continue;"),
 ("B7 retract boundary >= -> >", "now - a.dialogSince >= NOTICE_MIN_AGE_MS) continue;", "now - a.dialogSince > NOTICE_MIN_AGE_MS) continue;"),
 ("B8 noticeOwner tie-break dropped", "|| (since === best && isBlocked)) newest = a;", ") newest = a;"),
 ("B9 retract any blocked reason", "!HUMAN_BLOCKING.has(a.state) || a.blockedReason !== \"permission_prompt\") continue;", "!HUMAN_BLOCKING.has(a.state)) continue;"),
 # rule c: standing
 ("C1 standing never suppresses newest", "      if (standing.length === 0) {", "      if (true) {"),
 ("C2 standing filter >= -> >", "blocked.filter((a) => observedAt >= dialogStart(a));", "blocked.filter((a) => observedAt > dialogStart(a));"),
 ("C3 every blocked agent is standing", "blocked.filter((a) => observedAt >= dialogStart(a));", "blocked.filter((a) => a !== null);"),
 # rule d: idle skip
 ("D1 no waitingOnHuman skip", "if (providerBusy || waitingOnHuman) continue;", "if (providerBusy) continue;"),
 ("D2 skip only for permission blocks", "some((a) => HUMAN_BLOCKING.has(a.state));", "some((a) => HUMAN_BLOCKING.has(a.state) && a.blockedReason === \"permission_prompt\");"),
 ("D3 skip only for unacknowledged blocks", "some((a) => HUMAN_BLOCKING.has(a.state));", "some((a) => HUMAN_BLOCKING.has(a.state) && a.acknowledgedAt === null);"),
 # rule e: R4
 ("E1 R4 removed", "      blocked &&\n      blocking &&\n      LISTING_ENDS.has(agent.blockedReason ?? \"\") &&\n      !LISTING_ENDS.has(ev.notificationKind ?? \"\")", "      false"),
 ("E2 R4 without `blocked`", "      blocked &&\n      blocking &&", "      blocking &&"),
 ("E3 R4 without new-kind check", "      LISTING_ENDS.has(agent.blockedReason ?? \"\") &&\n      !LISTING_ENDS.has(ev.notificationKind ?? \"\")", "      LISTING_ENDS.has(agent.blockedReason ?? \"\")"),
 ("E4 R4 without old-reason check", "      LISTING_ENDS.has(agent.blockedReason ?? \"\") &&\n      !LISTING_ENDS.has(ev.notificationKind ?? \"\")", "      !LISTING_ENDS.has(ev.notificationKind ?? \"\")"),
]
only = set(sys.argv[2:]) if len(sys.argv) > 2 else None
files = sys.argv[1].split(",")
orig = open(F).read()
res = []
try:
    for name, a, b in M:
        if only and name.split()[0] not in only: continue
        n = orig.count(a)
        if n != 1:
            res.append((name, f"PATTERN COUNT {n}")); continue
        open(F, "w").write(orig.replace(a, b))
        p = subprocess.run(["npx", "vitest", "run", *files], cwd=WT, capture_output=True, text=True, timeout=600)
        out = p.stdout + p.stderr
        failed = [l.strip() for l in out.splitlines() if l.strip().startswith("×")]
        summary = [l.strip() for l in out.splitlines() if "Tests " in l]
        status = "KILLED" if p.returncode != 0 else "SURVIVED"
        res.append((name, f"{status} {summary[-1] if summary else ''} :: " + " | ".join(failed[:4])))
        print(name, "->", res[-1][1], flush=True)
finally:
    open(F, "w").write(orig)
