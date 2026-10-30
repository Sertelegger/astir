import json,sys
J=sys.argv[1]
labs=sys.argv[2].split(',')
def load(lab):
  d={}
  for l in open(f'{J}/out/{lab}.jsonl'):
    x=json.loads(l); d[x['name']]=x
  return d
def ts(s): return float(s.split('@')[1])
def B(st,who=None): return [s for s in st if s.startswith('B:') and (who is None or s.startswith('B:'+who))]
def R(st): return [s for s in st if s.startswith('R:')]
def end(x,k='main'): v=x['final'].get(k); return v['state'] if v else None
SUBP='a5c'
checks=[
 ('S1 (F1, VR3-86-1)', lambda d: not B(d['S1']['story'],SUBP) and not [s for s in R(d['S1']['story']) if ts(s)<90]),
 ('S1-control', lambda d: not B(d['S1-control']['story'],SUBP) and not [s for s in R(d['S1-control']['story']) if ts(s)<60]),
 ('S2 dead=false', lambda d: end(d['S2 dead=false'])=='blocked'),
 ('S2 dead=true (F2,F3)', lambda d: end(d['S2 dead=true'])=='blocked' and not B(d['S2 dead=true']['story'],'b6d')),
 ('S2c (F2)', lambda d: end(d['S2c'])=='blocked' and not B(d['S2c']['story'],SUBP)),
 ('S3 notice=true', lambda d: bool(B(d['S3 notice=true']['story'])) and max(ts(s) for s in d['S3 notice=true']['story'])<=36),
 ('S3 notice=false', lambda d: bool(B(d['S3 notice=false']['story']))),
 ('S8', lambda d: bool(B(d['S8']['story'])) and end(d['S8'])!='blocked' and max(ts(s) for s in d['S8']['story'])<=46),
 ('RY (VR3-86-1)', lambda d: not R(d['RY']['story']) and not B(d['RY']['story'],SUBP)),
 ('S4 (F4)', lambda d: d['S4']['final']['a5c']['state']=='idle'),
 ('S4b (F4)', lambda d: d['S4b']['final']['a5c']['state']=='idle'),
 ('S5 (F5)', lambda d: bool(B(d['S5']['story'])) and end(d['S5'])=='blocked'),
 ('R1 x5', lambda d: all(B(d[f'R1 bgNext={n}']['story'],'main') and not B(d[f'R1 bgNext={n}']['story'],'c7e') and not [s for s in R(d[f'R1 bgNext={n}']['story']) if ts(s)<59] for n in (3000,5000,8000,15000,40000))),
 ('R6 sweep (120)', lambda d: d['R6 sweep']['lost']==0 and d['R6 sweep']['bgAlerted']==0 and d['R6 sweep']['falseRes']==0),
 ('R1-rev sweep (45)', lambda d: d['R1-rev sweep (45)']['bgNamed']==0),
 ('self-denied alone x4', lambda d: all(not d[k]['story'] for k in d if k.startswith('selfdenied-alone'))),
 ('stale ask + early answer (30)', lambda d: d['stale-ask + answered at 2-4 s (30 runs)']['falseAlerts']==0),
 ('Esc at 20 clears in a poll', lambda d: all(s.endswith(tuple(f'@{n}' for n in range(21,26))) for s in d['(ii) Esc at 20']['stories'])),
 ('early answer <=4.5 s (100)', lambda d: all(v==0 for kind in ('esc','approve-long') for k,v in d[f'early {kind}: alerts /10 phases']['out'].items() if k!='ans5.5')),
 ('(iii) approve + long tool', lambda d: len(B(d['(iii) approve@20 long tool to 200']['story']))==1 and ts(R(d['(iii) approve@20 long tool to 200']['story'])[0])<=26),
 ('(v) subagent approve + long tool', lambda d: len(B(d['(v) sub dialog, approved@30, sub tool to 200']['story']))==1 and ts(R(d['(v) sub dialog, approved@30, sub tool to 200']['story'])[0])<=36),
 ('fan-out x2 (new)', lambda d: all(not [s for s in R(d[f'fanout sub2Done={n}']['story']) if ts(s)<60] for n in (15,30))),
 ('FileChanged in dialog (new)', lambda d: not [s for s in R(d['FileChanged at 10,20 during dialog 0.8..60']['story']) if ts(s)<60]),
 ('identical input (new)', lambda d: (lambda st: not [s for s in R(st) if ts(s)<60] and bool(R(st)) and ts(R(st)[-1])<=66)(d['identical input, other agent auto-approved']['story'])),
 ('AskUserQuestion after Bash x3', lambda d: all(len([s for s in d[f'AskUserQuestion after Bash phase={p}']['story'] if s.startswith('B:')])==2 for p in (0,2000,4000))),
]
rows={lab:load(lab) for lab in labs}
print('case'.ljust(34)+''.join(l[:12].ljust(13) for l in labs))
tot={l:0 for l in labs}
for name,f in checks:
  line=name.ljust(34)
  for l in labs:
    try: ok=f(rows[l])
    except Exception as e: ok=None
    tot[l]+= 1 if ok else 0
    line+=('pass' if ok else ('FAIL' if ok is False else 'n/a')).ljust(13)
  print(line)
print(('TOTAL /%d'%len(checks)).ljust(34)+''.join(str(tot[l]).ljust(13) for l in labs))
