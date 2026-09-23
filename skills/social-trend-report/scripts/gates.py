"""校验人工验收记录和产物绑定；本地文件不能证明消息真实性，仍须回读飞书来源。"""
import hashlib
import json
from pathlib import Path
from datetime import datetime

def check_approval(root,receipt,gate,artifact,context):
    if not isinstance(receipt,dict):return gate+' 缺少人工验收记录'
    for key,value in dict(context,gate=gate,decision='approved').items():
        if receipt.get(key)!=value:return gate+' 验收范围或决定不一致：'+key
    for key in ('actor_id','message_id'):
        if not isinstance(receipt.get(key),str) or not receipt[key].strip():return gate+' 缺少真实确认人/源消息'
    try:
        dt=datetime.fromisoformat(receipt['approved_at'].replace('Z','+00:00'))
        if dt.tzinfo is None:raise ValueError()
    except (KeyError,ValueError,TypeError,AttributeError):return gate+' 确认时间无效'
    path=Path(root)/artifact
    if path.is_symlink() or not path.is_file():return gate+' 缺少待验收产物'
    if receipt.get('artifact_sha256')!=hashlib.sha256(path.read_bytes()).hexdigest():return gate+' 产物已变化，需重新验收'
    return None

def check_gates(root,manifest,stage):
    try:
        path=Path(root)/'approvals.json'
        if path.is_symlink():raise ValueError()
        approvals=json.loads(path.read_text())
        if not isinstance(approvals,dict):raise ValueError()
    except (OSError,ValueError):return ['缺少有效 approvals.json']
    context={k:manifest.get(k) for k in ('run_id','project_id','input_sha256','rules_version')}
    pairs=[('HC1','sample-annotations.json'),('HC2','full-annotations.json')]
    if stage=='webpage':pairs.append(('HC3','approved-report.md'))
    errors=[]
    for gate,artifact in pairs:
        error=check_approval(root,approvals.get(gate),gate,artifact,context)
        if error:errors.append(error)
    return errors
