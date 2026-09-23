# V2 分阶段产物契约

每轮新建独立目录，UTF-8，单文件≤20MB，不允许符号链接。保留 run_id / project_id / period（含时区[start,end)）/原始input_sha256。

output-manifest.json：schema_version=2、rules_version=weekly-v2.1、stage=report或webpage、delivery_status=draft，以及上述上下文；files 为下面所需文件名→真实SHA256映射。

共同文件：
- events.json：对象，包含上下文及events数组。每个事件唯一event_id和真实source_urls；只收录报告中实际引用的事件，全量映射另存，不为符合校验而把全部原始事件塞进报告。
- quality.json：数据脚本结果，input_sha256、period_start/period_end、valid_count与本轮一致，approved:false保持不变。
- review-items.json：对象，含上下文与items数组。未解决问题不得删除；项须有status=resolved及resolution；无法处理则验证失败。
- report.md：四业务版块加一句话结论、周期与质量、来源与限制；重点事件列ID及原始链接。二级标题使用“## 营销发现”，该部分≤1800字（当前脚本保守按去空白文本计数，包含链接）。
- sample-annotations.json / full-annotations.json：对象，保存本次提交人工验收的完整标注结果（例如{rows:[...],phase1_health:{...},phase2_health:{...}}）。不可只提交空摘要，须真实完整产物。
- sample-health.json / full-health.json：最终合并健康度，run_id、rules_version一致，status=ready_for_review。每批还须保留两阶段health及错误明细；LLM不得自行改健康度状态。
- cost.json：人工可核对的真实调用账单汇总，complete=true仅在所有任务/补跑/洞察成本均已记录时设置。未提供成本不伪造完整交付。
- approvals.json：HC1/HC2各一对象；网页阶段额外HC3。字段：gate、decision=approved、run_id、project_id、input_sha256、rules_version、artifact_sha256、actor_id、message_id、approved_at(含时区)。HC1绑定sample-annotations.json，HC2绑定full-annotations.json，HC3绑定approved-report.md。

审批记录必须来自用户明确决定并可回读飞书消息，不能由Agent假装审批人；脚本仅验证字段与哈希，不证明消息真实性或有审批权限。业务方没有批准时即waiting_HC1/HC2/HC3。

stage=report：允许只有Markdown，HC1/HC2后提交飞书待审，不提前要求HTML或HC3。
stage=webpage：额外要求 approved-report.md（HC3后真实飞书回读快照）、report.html；report.md与快照必须相同。HTML完整html/body，动态内容转义；禁止脚本、事件属性、iframe、表单、SVG、外部样式及非http/https资源。不伪造/绕过私有图片鉴权，不能读取图片时报告阻塞。

运行 `python3 <本Skill>/scripts/validate.py --run-dir <目录>`。输出validation.json及退出码；0仅为draft_validated。外部发布必须通过真实回读并另存delivery-receipt.json，不能在本地清单自报published。

还需人工/语义复核：E1-E4口径、八路健康度、节点日历日期、来源真实性、HC3删改及截图完整性、发布可见范围。旧schema_version=1只为已有产物兼容，新流程必须使用2。
