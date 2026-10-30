import json,sys,collections
J=sys.argv[1]; labels=sys.argv[2].split(','); names=sys.argv[3:] if len(sys.argv)>3 else None
data=collections.OrderedDict()
for lab in labels:
  for l in open(f'{J}/out/{lab}.jsonl'):
    d=json.loads(l)
    data.setdefault(d['name'],{})[lab]=d
for name,per in data.items():
  if names and not any(n in name for n in names): continue
  print('###',name)
  for lab in labels:
    d=per.get(lab)
    if d is None: print(f'  {lab:18} -'); continue
    if 'story' in d:
      fin={k:(v['state']+('/'+v['reason'] if v and v.get('reason') else '')) if v else None for k,v in d['final'].items()}
      na=[x for x in d.get('notApplied',[]) if 'PostToolBatch' not in x]
      print(f'  {lab:18} {",".join(d["story"]) or "[]"}  | end {fin}' + (f' bb={d["blocksBegun"]}' if d.get('blocksBegun') is not None else '') + (f' NA={na[:3]}' if na else ''))
    else:
      e={k:v for k,v in d.items() if k not in ('tree','mode','name','rows')}
      print(f'  {lab:18} {json.dumps(e)}')
