---
name: yuanshu-skill-self-check
description: 当需要检查元枢技能库是否完整、技能为何未显示、内置技能数量异常或新增技能入库前验收时使用
---

# 元枢技能库自检

用真实索引和来源分类检查技能，不只看目录数量。

## 检查清单

1. 遍历 `D:\pi-web\skills`，确认每个技能目录都有 `SKILL.md`。
2. 检查 YAML frontmatter 存在，`name` 与目录名一致，名称只含小写字母、数字和连字符，`description` 非空且包含触发条件。
3. 用 `loadSkillIndex()` 检查技能能被索引；发现描述为空时先检查 UTF-8、BOM 和 CRLF，而不是直接重写内容。
4. 检查 `classifySkillSource()`：`D:\pi-web\skills` 必须是 `builtin`，工作区技能是 `local`，用户/安装目录是 `online`。
5. 检查 `formatSkillIndexPrompt()` 的长度限制和触发匹配，避免技能存在但因索引截断或描述模糊而不可用。
6. 至少运行：

```powershell
node --test tests/unit/skills-api.test.mjs tests/unit/skill-catalog-injection.test.mjs
npm run verify
```

## 入库规则

- 优先沉淀可复用的触发条件、输入、步骤、验收和失败处理；不要把一次性会话流水账直接塞进技能。
- 先搜索现有技能，能补强就修改已有技能，只有新能力才新建目录。
- 新技能落盘后再次加载索引并核对内置数量；前端显示异常时同时查 API source 分类，不把“目录有文件”当成“用户能用”。
- 任何涉及密钥、令牌或外部服务的检查只验证可用性，不输出敏感值。
