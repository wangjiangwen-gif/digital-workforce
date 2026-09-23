"""使用标准库准备社媒样本；不联网、不自动批准样本。"""
import argparse
import csv
import hashlib
import json
import math
from collections import defaultdict, deque
from datetime import datetime
from pathlib import Path
from workflow import normalize_heat


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('时间应为含时区的 ISO 字符串')
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        raise ValueError('时间缺少时区')
    return result


def prepare(input_path, start, end, sample_limit=500):
    if start >= end:
        raise ValueError('结束时间必须晚于开始时间')
    if sample_limit < 1 or sample_limit > 500:
        raise ValueError('样本量应为 1–500')
    raw = input_path.read_bytes()
    if input_path.suffix.lower() == '.csv':
        rows = list(csv.DictReader(raw.decode('utf-8-sig').splitlines()))
    elif input_path.suffix.lower() == '.json':
        rows = json.loads(raw)
        if not isinstance(rows, list):
            raise ValueError('JSON 顶层必须是记录数组')
    else:
        raise ValueError('仅支持 CSV 或 JSON')
    required = ['record_id', 'platform', 'title', 'source_url', 'published_at']
    metrics = ['views', 'likes', 'comments', 'shares', 'favorites', 'heat_value']
    issues, valid, seen = [], [], set()
    for index, original in enumerate(rows):
        if not isinstance(original, dict):
            issues.append({'row': index + 1, 'reason': '记录不是对象'})
            continue
        row = dict(original)
        missing = [k for k in required if not isinstance(row.get(k), str) or not row[k].strip()]
        if missing:
            issues.append({'row': index + 1, 'reason': '缺少字段', 'fields': missing})
            continue
        for key in required:
            row[key] = row[key].strip()
        if not row['source_url'].startswith(('https://', 'http://')):
            issues.append({'row': index + 1, 'reason': '来源链接协议无效'})
            continue
        try:
            date = timestamp(row['published_at'])
        except (ValueError, TypeError):
            issues.append({'row': index + 1, 'reason': '日期或时区无效'})
            continue
        if not start <= date < end:
            issues.append({'row': index + 1, 'reason': '统计周期之外'})
            continue
        identity = (row['platform'], row['record_id'])
        if identity in seen:
            issues.append({'row': index + 1, 'reason': '同平台记录 ID 重复；保留首条，需核查差异'})
            continue
        bad = False
        for metric in metrics:
            value = row.get(metric)
            if value is None or value == '':
                row[metric] = None
                continue
            try:
                if isinstance(value, bool):
                    raise ValueError()
                value = float(value)
                if not math.isfinite(value) or value < 0:
                    raise ValueError()
                row[metric] = value
            except (ValueError, TypeError):
                issues.append({'row': index + 1, 'reason': '非负数值指标无效', 'field': metric})
                bad = True
        if bad:
            continue
        seen.add(identity)
        row["row_id"] = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:24]
        valid.append(row)
    valid = normalize_heat(valid)
    buckets = defaultdict(list)
    for row in valid:
        local_date = timestamp(row['published_at']).astimezone(start.tzinfo).date().isoformat()
        buckets[(row['platform'], local_date)].append(row)
    queues = [deque(sorted(values, key=lambda r: hashlib.sha256((r['platform'] + r['record_id']).encode()).hexdigest()))
              for _, values in sorted(buckets.items())]
    sample = []
    while len(sample) < sample_limit and any(queues):
        for queue in queues:
            if queue and len(sample) < sample_limit:
                sample.append(queue.popleft())
    quality = {'schema_version': 1, 'input_sha256': hashlib.sha256(raw).hexdigest(),
               'period_start': start.isoformat(), 'period_end': end.isoformat(),
               'input_count': len(rows), 'valid_count': len(valid), 'sample_count': len(sample),
               'valid_record_ratio': len(valid) / len(rows) if rows else None,
               'rules_version': 'weekly-v2.1', 'heat_normalization': 'platform log1p + linear P1/P99, clip [0,100]; constant/missing=null',
               'sampling': '按平台与日期分层，稳定哈希排序，轮询取样',
               'approved': False, 'label_agreement': None, 'merge_precision': None, 'issues': issues}
    return {'normalized.json': valid, 'sample.json': sample, 'quality.json': quality}


def main():
    parser = argparse.ArgumentParser(description='准备社媒热点分析输入与人工验收样本')
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--start', required=True, type=timestamp)
    parser.add_argument('--end', required=True, type=timestamp)
    parser.add_argument('--sample-limit', type=int, default=500)
    args = parser.parse_args()
    try:
        results = prepare(args.input, args.start, args.end, args.sample_limit)
        args.out.mkdir(parents=True, exist_ok=False)
        for name, value in results.items():
            (args.out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
        print(json.dumps({'output': str(args.out), 'approved': False, 'valid_count': len(results['normalized.json'])}))
    except (ValueError, OSError, TypeError) as error:
        parser.exit(1, f'数据准备失败：{error}\n')


if __name__ == '__main__':
    main()
