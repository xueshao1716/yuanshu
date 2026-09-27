---
name: web-search
description: 网页搜索。使用 Brave Search API 搜索网页内容。需要环境变量 BRAVE_API_KEY（可选，无 key 时提示配置）。当用户需要搜索最新信息、查找资料时使用。
---

# Web Search

使用 Brave Search API 搜索网页。

## 前提

需要 Brave Search API key（免费申请：https://brave.com/search/api/）。设置环境变量：

```bash
export BRAVE_API_KEY=你的key
```

Windows 用户可通过系统环境变量或 pi-web 模型管理配置。

## 用法

```bash
curl -s "https://api.search.brave.com/res/v1/web/search?q=<查询词>&count=10" \
  -H "Accept: application/json" \
  -H "X-Subscription-Token: $BRAVE_API_KEY"
```

## 输出

返回 JSON：标题、URL、描述、发布时间。整理为简洁列表呈现给用户，标注来源。
