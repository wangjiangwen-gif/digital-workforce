# DataHub 文件适配契约 · weekly-v2.1

当前未接 DataHub MCP。不得猜工具名、调用地址或伪造执行记录。支持业务方从真实任务导出以下结果，由适配脚本校验。文件导入不代表已实现服务端自动编排。

## 输入
prepare.py 保留原字段，新增稳定 row_id（platform + record_id 的 SHA256 前 24 位）、heat_score。
heat_score：同平台 log1p(heat_value)，线性插值 P1/P99，裁剪并映射 0–100。缺失或恒定值为 null；同平台单位冲突阻塞。原文未指定退化口径，此策略须业务确认；不能补成零。
每平台上一完整自然周，Asia/Shanghai，[周一00:00,下周一00:00)。测试指定周期优先，不把测试数据当真实热点。缺少四平台中的某个平台需记录覆盖限制。

## 标注导出
```json
{
  "run_id":"本轮ID",
  "rules_version":"weekly-v2.1",
  "phase":"phase1",
  "input_sha256":"传入 --input 文件的真实SHA256",
  "tasks":{
    "C0":{"prompt_version":"实际版本","source_ref":"真实外部任务ID或获授权导出文件来源","cost_cny":null,"rows":[]},
    "C3":{"prompt_version":"实际版本","source_ref":"真实来源","cost_cny":null,"rows":[]}
  }
}
```

每条结果必须有 row_id。布尔值只能 true/false，未知用缺失/错误记录，不能变成 false。字段约定如下：
- C0：marketing_usable:boolean，entities/drivers/industries:string[]，trigger:string。
- C3：nodes/brands:string[]，holiday_marketing/custom_marketing:boolean。
- R1/R2/R3/R4/R5：value:boolean，reason:非空字符串；导入后映射为 platform_play/commercial/risk/discovery/consumer 及各自 `_reason`。
- C2：event_id/event_name/reason:非空字符串。保留真实聚类来源和版本，优先已有 canonical-event-registry v2，不用简单关键词分组假冒它。

这是本平台适配字段，不宣称已经是客户正式 28 列。正式列名/完整 Prompt/节点表待接入后映射；不得补造列来凑 28 列。

## 两批执行
第一批 C0、C3 处理同一输入全量，可并发。导入 phase1 后只有有效且 marketing_usable=true 的行进入 usable.json。
第二批 R1-R5、C2 只接受该子集；workflow.py --phase phase2 的 --input 传 phase1/rows.json（LEFT JOIN 保留全部原行，标签只接受营销可用行）。进入第二批前检查第一批 health，残余失败项先补齐或取得有范围的人工排除决定，不能让缺失标签冒充非营销。

命令：
`python3 <data_skill>/scripts/workflow.py --input <本批输入.json> --annotations <真实导出.json> --phase phase1 --out <新目录> --run-id <run_id>`
第二批改为 phase2；小样本、全量分别创建独立目录。每次补标注输出新的合并导出文件及目录，不覆盖上次证据。

输出 rows.json / usable.json / health.json / cost.json。成本未知为 null，不把排队时间算作模型调用费用；补跑成本另记并汇总，不能只统计末轮成功调用。

## 故障处理
网络瞬断：按外部任务ID核查后重试；内容超限：缩小批次；质量问题：修正版本重标；整路缺失：整路阻塞。
任一路整体缺失都阻塞；预期行中解析失败/缺失的并集占比 >5% 阻塞。补标注最多3轮，每轮保留输入、输出、版本、错误和成本。达到上限仍失败时请求人工裁决；当前脚本不提供自动越权开关，人工放行必须留身份、理由、范围和源消息，并显式披露缺口。
