"""四版块确定性统计；不联网、不生成语义标签，不进行跨平台热度排名。"""
import argparse
from collections import defaultdict,Counter
from datetime import date,timedelta
import json
import math
from pathlib import Path

def score(row):
    x=row.get('heat_score')
    return x if type(x) in (int,float) and math.isfinite(x) else None

def peak(rows):return max((score(r) for r in rows if score(r) is not None),default=None)

def terms(row,key):
    value=row.get(key,[])
    if isinstance(value,str):value=value.split('|')
    return sorted(set(x.strip() for x in value if isinstance(x,str) and x.strip()))

def driving_words(rows):
    groups=defaultdict(list)
    for r in rows:
        for word in terms(r,'drivers'):groups[word].append(r)
    candidates=[];maximum=max((len(v) for v in groups.values()),default=0)
    for word,items in groups.items():
        if len(items)<=1:continue
        values=[score(r) for r in items if score(r) is not None]
        # 不把缺失标准分补零，缺失者保留在审计清单并不参与排名。
        if len(values)!=len(items):continue
        mean=sum(values)/len(values);freq=math.log2(len(items))/math.log2(maximum+1)
        candidates.append({'word':word,'frequency':len(items),'mean':mean,'freq_norm':freq,'raw':mean*(.7+.3*freq),
                           'sources':[{'row_id':r['row_id'],'title':r['title'],'url':r['source_url']} for r in items]})
    low=min((r['raw'] for r in candidates),default=0);high=max((r['raw'] for r in candidates),default=0)
    for r in candidates:r['index']=100.0 if high==low else 40+60*(r['raw']-low)/(high-low)
    return sorted(candidates,key=lambda r:(-r['index'],r['word']))

def summarize(rows,calendar,publish_date):
    if len({r['row_id'] for r in rows})!=len(rows):raise ValueError('重复 row_id')
    usable=[r for r in rows if r.get('marketing_usable') is True]
    industries=defaultdict(list);platforms=defaultdict(list)
    for r in usable:
        for name in terms(r,'industries'):industries[name].append(r)
        platforms[r['platform']].append(r)
    e1=[]
    for name,items in industries.items():
        events=defaultdict(list)
        for r in items:
            if r.get('event_id'):events[r['event_id']].append(r)
        ranked=sorted(events.values(),key=lambda v: (-(peak(v) if peak(v) is not None else -1),v[0]['event_id']))
        words=Counter(w for r in items for w in terms(r,'drivers'))
        e1.append({'industry':name,'count':len(items),'peak_heat':peak(items),'top_events':[v[0].get('event_name') for v in ranked[:3]],'drivers':words.most_common(3)})
    e1=sorted(e1,key=lambda x:(-x['count'],x['industry']))[:10]
    dates={};upcoming=[]
    for item in calendar:
        d=date.fromisoformat(item['date']);dates.setdefault(item['name'],[]).append(d)
        if publish_date<=d<=publish_date+timedelta(days=6):upcoming.append(item)
    node_rows=defaultdict(list);supplement=[]
    for r in usable:
        for name in terms(r,'nodes'):node_rows[name].append(r)
    past=[]
    for name,items in node_rows.items():
        known=dates.get(name,[])
        anchor=min(known,key=lambda d:abs((d-publish_date).days)) if known else None
        dist=(anchor-publish_date).days if anchor else None
        if dist is not None and dist>=0:supplement.append(name);continue
        if dist is not None and dist< -7:continue
        past.append({'node':name,'anchor':anchor.isoformat() if anchor else None,'date_unverified':anchor is None,
                     'count':len(items),'peak_heat':peak(items),'brands':sorted({x for r in items for x in terms(r,'entities')}),
                     'categories':sorted({x for r in items for x in terms(r,'industries')}),'sources':[r['source_url'] for r in items]})
    e3={};audit={}
    for platform,items in sorted(platforms.items()):
        events=defaultdict(list)
        for r in items:
            if r.get('event_id'):events[r['event_id']].append(r)
        candidates=[v for v in events.values() if len(v)>=2]
        candidates.sort(key=lambda v:(-len(v),-(peak(v) if peak(v) is not None else -1),v[0]['event_id']))
        top=[]
        for group in candidates[:5]:
            representatives=sorted(group,key=lambda r:(-(score(r) if score(r) is not None else -1),r['row_id']))[:3]
            top.append({'event_id':group[0]['event_id'],'event_name':group[0].get('event_name'),'count':len(group),'peak_heat':peak(group),
                        'industries':sorted({x for r in group for x in terms(r,'industries')}),
                        'sources':[{'title':r['title'],'url':r['source_url'],'row_id':r['row_id']} for r in representatives]})
        words=driving_words(items);audit[platform]=words[:10]
        e3[platform]={'top_events':top,'top_words':words[:3] if len(words)>=2 else [],
                      'note':None if top else '上周热门事件均为单条独立话题或缺少可核验事件簇'}
    # 不以跨平台分数混排 E4；各平台独立截取候选，跨平台选稿由业务复核。
    e4={}
    for field,limit in [('commercial',20),('risk',20),('discovery',15),('consumer',20)]:
        e4[field]={}
        for platform,items in sorted(platforms.items()):
            candidates=[r for r in items if r.get(field) is True]
            candidates.sort(key=lambda r:(-(score(r) if score(r) is not None else -1),r['row_id']))
            e4[field][platform]=candidates[:limit]
    return {'E1':e1,'E2':{'past':past,'upcoming':sorted(upcoming,key=lambda x:x['date']),'supplement':sorted(supplement)},
            'E3':e3,'E4':e4,'word_audit':audit,
            'limitations':['E1/E2 热度为平台标准分最大值，仅描述性展示，不视作跨平台可比强度。',
                            'E4 候选上限按平台执行；跨平台取舍待业务确认，不能直接混排原始热度。']}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',required=True,type=Path);p.add_argument('--calendar',required=True,type=Path)
    p.add_argument('--publish-date',required=True,type=date.fromisoformat);p.add_argument('--out',required=True,type=Path);a=p.parse_args()
    result=summarize(json.loads(a.input.read_text()),json.loads(a.calendar.read_text()),a.publish_date)
    a.out.mkdir(parents=True,exist_ok=False)
    (a.out/'statistics.json').write_text(json.dumps(result,ensure_ascii=False,indent=2,allow_nan=False))
    (a.out/'candidates.json').write_text(json.dumps(result['E4'],ensure_ascii=False,indent=2,allow_nan=False))
    lines=['# 平台热点词审计','与正式榜单复用 driving_words()；仅同平台比较。']
    for platform,words in result['word_audit'].items():
        lines+=['## '+platform,'```json',json.dumps(words,ensure_ascii=False,indent=2),'```']
    (a.out/'e3_word_freq_audit.md').write_text('\n'.join(lines))
if __name__=='__main__':main()
