#!/usr/bin/env python3
"""验证本地报告产物；不以本地自报状态证明远端发布或业务真实性。"""
import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from datetime import datetime
from urllib.parse import urlparse
from gates import check_gates

FILES = ('events.json', 'quality.json', 'review-items.json', 'report.md', 'report.html')
SECTIONS = ('一句话结论', '周期与质量', '热点格局', '传播变化', '内容机会', '风险与行动', '事件清单', '行动建议', '来源与限制')
SECTIONS_V2 = ('一句话结论', '周期与质量', '行业及热门话题', '营销节点', '平台新鲜事', '营销发现', '来源与限制')


def http_url(value):
    try:
        parsed = urlparse(value)
        return parsed.scheme in ('http', 'https') and bool(parsed.hostname) and not parsed.username and not parsed.password
    except (TypeError, ValueError):
        return False


class ReportHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.unsafe = False
        self.text = []
        self.tags = set()

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        if tag in ('script', 'iframe', 'object', 'embed', 'form', 'base', 'link', 'svg', 'math'):
            self.unsafe = True
        if tag == 'meta' and any(name not in ('charset', 'name', 'content') for name, _ in attrs):
            self.unsafe = True
        for name, value in attrs:
            if name.startswith('on') or name in ('srcdoc', 'style'):
                self.unsafe = True
            if name in ('href', 'src', 'action', 'poster', 'data', 'xlink:href', 'srcset') and not http_url(value):
                self.unsafe = True

    handle_startendtag = handle_starttag

    def handle_data(self, value):
        self.text.append(value)


def validate(root):
    root = Path(root).resolve()
    errors = []
    hashes = {}

    def fail(code, file, message):
        errors.append({'code': code, 'file': file, 'message': message})

    def read(name, json_file=False):
        path = root / name
        try:
            if path.is_symlink() or not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
                raise ValueError('文件不存在、为符号链接或超过 20 MB')
            raw = path.read_bytes()
            hashes[name] = hashlib.sha256(raw).hexdigest()
            text = raw.decode('utf-8')
            if not text.strip():
                raise ValueError('文件为空')
            if not json_file:
                return text
            value = json.loads(text)
            if not isinstance(value, dict):
                fail('INVALID_SCHEMA', name, 'JSON 顶层必须为对象')
                return {}
            return value
        except (OSError, ValueError) as error:
            fail('INVALID_FILE', name, str(error))
            return {} if json_file else ''

    manifest = read('output-manifest.json', True)
    v2 = manifest.get('schema_version') == 2
    stage = manifest.get('stage', 'report')
    files = tuple(n for n in FILES if not (v2 and stage == 'report' and n == 'report.html'))
    if v2:
        if manifest.get('rules_version') != 'weekly-v2.1' or stage not in ('report', 'webpage'):
            fail('INVALID_SCHEMA', 'output-manifest.json', 'V2 必须指定 weekly-v2.1 和 report/webpage 阶段')
        for error in check_gates(root, manifest, stage):
            fail('APPROVAL_REQUIRED', 'approvals.json', error)
        extra = ('approvals.json', 'sample-annotations.json', 'full-annotations.json', 'sample-health.json', 'full-health.json', 'cost.json')
        if stage == 'webpage': extra += ('approved-report.md',)
        files += extra
    if manifest.get('schema_version') not in (1, 2):
        fail('INVALID_SCHEMA', 'output-manifest.json', 'schema_version 必须为 1')
    for field in ('run_id', 'project_id'):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            fail('INVALID_CONTEXT', 'output-manifest.json', field + ' 不能为空')
    if not re.fullmatch(r'[a-f0-9]{64}', str(manifest.get('input_sha256', ''))):
        fail('INVALID_CONTEXT', 'output-manifest.json', 'input_sha256 必须为输入文件 SHA256')
    try:
        period = manifest['period']
        start, end = (datetime.fromisoformat(period[k].replace('Z', '+00:00')) for k in ('start', 'end'))
        if start.tzinfo is None or end.tzinfo is None or start >= end:
            raise ValueError()
    except (KeyError, TypeError, ValueError, AttributeError):
        fail('INVALID_CONTEXT', 'output-manifest.json', '周期必须是带时区的开始和结束时间，开始早于结束')
    if manifest.get('delivery_status') != 'draft':
        fail('UNVERIFIED_DELIVERY', 'output-manifest.json', '本验证器仅验收本地产物；远端发布须另以真实服务回读验证，不能自报成功')
    contents = {name: read(name, name.endswith('.json')) for name in files}
    expected = manifest.get('files')
    if not isinstance(expected, dict):
        expected = {}
    for name in files:
        if not re.fullmatch(r'[a-f0-9]{64}', str(expected.get(name, ''))) or expected.get(name) != hashes.get(name):
            fail('HASH_MISMATCH', name, '文件缺少 SHA256 或已在清单生成后被修改')
    if v2:
        for name in ('sample-annotations.json', 'full-annotations.json'):
            rows = contents[name].get('rows')
            if not isinstance(rows, list) or not rows or any(not isinstance(row, dict) or not row.get('row_id') for row in rows):
                fail('INVALID_ANNOTATIONS', name, '验收文件必须包含真实非空 rows 及 row_id，不能只提交空摘要')
            elif len({str(row['row_id']) for row in rows}) != len(rows):
                fail('INVALID_ANNOTATIONS', name, '验收文件 row_id 重复')
        for name in ('sample-health.json', 'full-health.json'):
            health = contents[name]
            if health.get('status') != 'ready_for_review' or health.get('run_id') != manifest.get('run_id') or health.get('rules_version') != manifest.get('rules_version'):
                fail('HEALTH_BLOCKED', name, '缺少同轮通过机器检查的健康度报告')
        if contents['cost.json'].get('complete') is not True:
            fail('COST_INCOMPLETE', 'cost.json', '成本尚未汇总完整，不得声称完整交付')
    if v2 and stage == 'webpage' and contents['report.md'] != contents['approved-report.md']:
        fail('APPROVED_REPORT_CHANGED', 'report.md', '网页阶段必须使用 HC3 对应的飞书回读版本')
    if v2:
        part = re.search(r'^##\s*营销发现\s*\n(.*?)(?=^##\s|\Z)', contents['report.md'], re.M | re.S)
        if part and len(re.sub(r'\s', '', part.group(1))) > 1800:
            fail('SECTION_TOO_LONG', 'report.md', '营销发现部分超过1800字，请精简')
    for name in ('events.json', 'review-items.json', 'quality.json'):
        fields = ('period', 'input_sha256') if name == 'quality.json' else ('run_id', 'project_id', 'period', 'input_sha256')
        for field in fields:
            actual = contents[name].get(field)
            if name == 'quality.json' and field == 'period':
                actual = {'start': contents[name].get('period_start'), 'end': contents[name].get('period_end')}
            if actual != manifest.get(field):
                fail('CONTEXT_MISMATCH', name, field + ' 与本轮清单不一致')
    events = contents['events.json'].get('events')
    if not isinstance(events, list) or not events:
        fail('INVALID_SCHEMA', 'events.json', 'events 必须为非空事件数组；无数据时返回阻塞原因，不能生成成功报告')
        events = []
    seen = set()
    for event in events:
        if not isinstance(event, dict):
            fail('INVALID_SCHEMA', 'events.json', '事件必须为对象')
            continue
        event_id = event.get('event_id')
        if not isinstance(event_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', event_id) or event_id in seen:
            fail('INVALID_EVENT', 'events.json', 'event_id 必须唯一且非空，仅使用字母数字、连字符、下划线')
            continue
        seen.add(event_id)
        urls = event.get('source_urls')
        if not isinstance(urls, list) or not urls or not all(http_url(url) for url in urls):
            fail('INVALID_SOURCE', 'events.json', event_id + ' 缺少有效来源 URL')
            continue
        for name in (n for n in ('report.md', 'report.html') if n in files):
            report = contents[name]
            # 检查可追溯性；URL 的真实性与结论是否被来源支持仍须语义复核。
            if not re.search(r'(?<![\w-])' + re.escape(event_id) + r'(?![\w-])', report) or not any(url in report or url.replace('&', '&amp;') in report for url in urls):
                fail('MISSING_CITATION', name, event_id + ' 缺少事件编号或来源链接')
    review = contents['review-items.json'].get('items')
    if not isinstance(review, list):
        fail('INVALID_SCHEMA', 'review-items.json', 'items 必须为数组')
    elif any(not isinstance(item, dict) or item.get('status') != 'resolved' or not item.get('resolution') for item in review):
        fail('PENDING_REVIEW', 'review-items.json', '存在未解决或未记录处理依据的复核项')
    quality = contents['quality.json']
    if type(quality.get('valid_count')) is not int or quality['valid_count'] < 1:
        fail('INVALID_DATA', 'quality.json', '没有有效数据')
    html = ReportHTML()
    html.feed(contents.get('report.html', '<html><body></body></html>'))
    if html.unsafe or not {'html', 'body'}.issubset(html.tags):
        fail('UNSAFE_HTML', 'report.html', '使用完整静态 HTML；禁止脚本、嵌入内容、事件属性、内联样式和非 HTTP(S) 资源')
    for name, text in [('report.md', contents['report.md']), *([('report.html', ' '.join(html.text))] if 'report.html' in files else [])]:
        for section in (SECTIONS_V2 if v2 else SECTIONS):
            if section not in text:
                fail('MISSING_SECTION', name, '缺少章节：' + section)
        if re.search(r'\bTODO\b|\bTBD\b|\{\{[^}]+\}\}|待填写|待填入|请填入|在此填写', text, re.I):
            fail('PLACEHOLDER', name, '报告存在未替换占位内容')
    return {'schema_version': 2 if v2 else 1, 'run_id': manifest.get('run_id'), 'status': 'failed' if errors else 'draft_validated', 'errors': errors, 'file_sha256': hashes, 'requires_semantic_review': True, 'remote_delivery_verified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True)
    args = parser.parse_args()
    root = Path(args.run_dir)
    result = validate(root)
    output = root / 'validation.json'
    # 避免沿产物目录中的符号链接写入其他文件。
    if output.is_symlink():
        raise SystemExit('validation.json 不允许为符号链接')
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': result['status'], 'error_count': len(result['errors']), 'result': str(output)}, ensure_ascii=False))
    raise SystemExit(1 if result['errors'] else 0)


if __name__ == '__main__':
    main()
