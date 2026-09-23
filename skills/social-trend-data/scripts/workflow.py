"""文件模式标注适配器：只读取真实导出结果，不发起或模拟 DataHub 任务。"""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path

VERSION='weekly-v2.1'
ROUTES={'R1':'platform_play','R2':'commercial','R3':'risk','R4':'discovery','R5':'consumer'}

def percentile(values,p):
    x=(len(values)-1)*p;lo=int(x);hi=min(lo+1,len(values)-1)
    return values[lo]+(values[hi]-values[lo])*(x-lo)

def normalize_heat(rows):
    groups=defaultdict(list)
    result=[dict(r,heat_score=None) for r in rows]
    for row in result:
        value=row.get('heat_value')
        if value is None:continue
        if type(value) not in (int,float) or not math.isfinite(value) or value<0:raise ValueError('热度必须为非负有限数值')
        groups[row['platform']].append(row)
    for platform,items in groups.items():
        units={r.get('heat_unit') for r in items}
        if len(units)>1:raise ValueError(platform+' 同平台热度单位不一致，先确认口径')
        values=sorted(math.log1p(r['heat_value']) for r in items)
        low,high=percentile(values,.01),percentile(values,.99)
        # 文档未定义恒定值退化口径，保留未知，不虚构排序。
        if high==low:continue
        for row in items:row['heat_score']=round(100*max(0,min(1,(math.log1p(row['heat_value'])-low)/(high-low))),6)
    return result

def valid_strings(v):return isinstance(v,list) and all(isinstance(x,str) and x.strip() for x in v)

def valid_label(task,row):
    if task=='C0':return type(row.get('marketing_usable')) is bool and all(valid_strings(row.get(k)) for k in ('entities','drivers','industries')) and isinstance(row.get('trigger'),str)
    if task=='C3':return valid_strings(row.get('nodes')) and valid_strings(row.get('brands')) and all(type(row.get(k)) is bool for k in ('holiday_marketing','custom_marketing'))
    if task=='C2':return all(isinstance(row.get(k),str) and row[k].strip() for k in ('event_id','event_name','reason'))
    return type(row.get('value')) is bool and isinstance(row.get('reason'),str) and bool(row['reason'].strip())

def merge_annotations(rows,annotations,phase):
    ids=[r.get('row_id') for r in rows]
    if any(not isinstance(x,str) or not x for x in ids) or len(set(ids))!=len(ids):raise ValueError('row_id 必须非空且唯一')
    tasks=['C0','C3'] if phase=='phase1' else [*ROUTES,'C2']
    eligible=set(ids) if phase=='phase1' else {r['row_id'] for r in rows if r.get('marketing_usable') is True and r.get('annotation_valid') is not False}
    merged={r['row_id']:dict(r) for r in rows};bad=set();missing=[];stats={}
    for task in tasks:
        values=annotations.get(task)
        if values is None:
            if eligible:missing.append(task)
            values=[]
        if not isinstance(values,list):raise ValueError(task+' 结果必须为数组')
        seen=set();invalid=set()
        for label in values:
            if not isinstance(label,dict):raise ValueError(task+' 记录必须为对象')
            rid=label.get('row_id')
            if rid not in eligible or rid in seen:raise ValueError(task+' 包含重复、未知或不属于本批次的 row_id')
            seen.add(rid)
            if not valid_label(task,label):invalid.add(rid);continue
            target=merged[rid]
            if task in ROUTES:
                target[ROUTES[task]]=label['value'];target[ROUTES[task]+'_reason']=label['reason']
            elif task=='C2':target.update({k:label[k] for k in ('event_id','event_name')});target['merge_reason']=label['reason']
            else:
                fields=('marketing_usable','entities','drivers','industries','trigger') if task=='C0' else ('nodes','holiday_marketing','brands','custom_marketing')
                target.update({k:label[k] for k in fields})
        errors=(eligible-seen)|invalid;bad.update(errors)
        stats[task]={'expected':len(eligible),'received':len(seen),'invalid_or_missing':len(errors),'error_rate':len(errors)/len(eligible) if eligible else 0}
    # 不把部分标注失败的记录悄悄喂给下一批。
    for rid, row in merged.items():
        row['annotation_valid'] = row.get('annotation_valid', True) and rid not in bad
    usable=[r for rid,r in merged.items() if r.get('marketing_usable') is True and rid not in bad]
    rate=len(bad)/len(eligible) if eligible else 0
    health={'schema_version':2,'phase':phase,'status':'blocked' if missing or rate>.05 else 'ready_for_review',
            'missing_tasks':missing,'tasks':stats,'invalid_row_ids':sorted(bad),'invalid_rate':rate,
            'marketing_usable_count':len(usable),'total_count':len(rows),'human_approved':False}
    return {'rows':list(merged.values()),'usable':usable,'health':health}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',required=True,type=Path)
    parser.add_argument('--annotations',required=True,type=Path)
    parser.add_argument('--phase',choices=['phase1','phase2'],required=True)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--run-id',required=True)
    parser.add_argument('--rules-version',default=VERSION)
    args=parser.parse_args()
    raw=args.input.read_bytes();envelope=json.loads(args.annotations.read_text())
    for k,v in {'input_sha256':hashlib.sha256(raw).hexdigest(),'run_id':args.run_id,'rules_version':args.rules_version,'phase':args.phase}.items():
        if envelope.get(k)!=v:parser.error(k+' 与当前批次不一致')
    tasks=envelope.get('tasks',{});annotations={};costs=[]
    if not isinstance(tasks,dict):parser.error('tasks 必须为对象')
    for name,task in tasks.items():
        if name not in ('C0','C3','C2',*ROUTES) or not isinstance(task,dict):parser.error('未知任务')
        if not all(isinstance(task.get(k),str) and task[k].strip() for k in ('prompt_version','source_ref')):parser.error('缺少 Prompt 版本或真实任务/导出来源')
        annotations[name]=task.get('rows')
        amount=task.get('cost_cny')
        if amount is not None and (type(amount) not in (int,float) or not math.isfinite(amount) or amount<0):parser.error('成本无效')
        costs.append({'task':name,'cost_cny':amount,'source_ref':task['source_ref'],'prompt_version':task['prompt_version']})
    result=merge_annotations(json.loads(raw),annotations,args.phase)
    result['health'].update(run_id=args.run_id,input_sha256=envelope['input_sha256'],rules_version=args.rules_version,
                            annotation_sha256=hashlib.sha256(args.annotations.read_bytes()).hexdigest())
    args.out.mkdir(parents=True,exist_ok=False)
    for name,value in result.items():(args.out/(name+'.json')).write_text(json.dumps(value,ensure_ascii=False,indent=2,allow_nan=False))
    (args.out/'cost.json').write_text(json.dumps({'tasks':costs,'known_total_cny':sum(c['cost_cny'] or 0 for c in costs),'complete':all(c['cost_cny'] is not None for c in costs)},ensure_ascii=False,indent=2))
    print(json.dumps(result['health'],ensure_ascii=False))
    raise SystemExit(2 if result['health']['status']=='blocked' else 0)
if __name__=='__main__':main()
