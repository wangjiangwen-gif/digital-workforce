---
name: social-trend-insights
description: "[social-trends] 周报 V2 四版块洞察：行业及热门话题、营销节点、平台新鲜事、营销发现；脚本统计和热点词审计，HC2 后生成有来源的报告内容。"
metadata:
  tags: social-trends
  platform: digital-workforce
---
# 四版块洞察 · weekly-v2.1

先读取 references/scoring.md。只使用同一run_id、数据和规则版本的全量结果，核对HC1/HC2真实确认记录。没有HC2就返回待验收，不把旧的“热点格局/传播变化/内容机会/风险与行动”当作本报告四版块。

运行 scripts/statistics.py 生成 statistics.json、candidates.json、e3_word_freq_audit.md。计算交给脚本，写作只依据统计与来源。E1-E4 可并发撰写；缺依赖时保留可完成版块及阻塞原因，不能填满假数据。

每个重点结论关联 event_id、row_id、原始source_url。不将传闻变事实，不把热度当销售或因果。节点日历只认已提供的真实日期。E4二次打标只有真实能力可用才执行，失败按规则降级并披露。

输出 E1.md/E2.md/E3.md/E4.md、insights.md、events.json（仅收录实际进入报告的事件，并保留到全量宽表的引用）和review-items.json。不确定项保留待核验，不能删除来绕过Validator。rules_version=weekly-v2.1，运行目录与输入SHA256贯穿全部产物。
