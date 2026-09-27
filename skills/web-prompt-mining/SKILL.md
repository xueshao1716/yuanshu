---
name: web-prompt-mining
description: 当用户要整理 AI 网站公开提示词、预设、灵感库或模板语料时使用：分析前端和公开接口，核实可访问范围，提取并保存来源。
---

# 网站提示词挖掘（web-prompt-mining）

原始说明（完整保留）：当用户要扒某个 AI 网站/APP 的提示词、预设指令、灵感库、模板库语料时使用（"XX网站的提示词扒一下"）。做法：抓前端 chunk → 挖 API 基址与端点 → 逐个试鉴权 → 全量收割 → 双份落盘。适用于任意前端框架（Vite/Rolldown/Next.js）。

一句话：**扒 chunk → 挖 API → 试鉴权 → 全量收 → 双份落盘**。
核心判断：提示词语料几乎从不写在页面 HTML 里，而是**由接口下发**；
接口和它的鉴权要求写在**前端 chunk** 里。所以扒站本质是"读它的前端"。

## 流程

### 1. 落地侦察
```bash
mkdir -p /tmp/<site>_js && cd /tmp/<site>_js
curl -s -m 20 -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/126" \
  "https://<site>" -o /tmp/<site>_home.html
head -c 3000 /tmp/<site>_home.html   # 看打包器：/assets/ = Vite/Rolldown，/_next/ = Next.js
```
**必须带浏览器 UA**——不带常被当成爬虫返回 404 页（用 `file` 或看开头字节识别）。
同时看首页 HTML 里的 `<title>` 和中文文案，先搞清这站到底是干嘛的。

### 2. 抓全 chunk（最容易漏的一步）
```bash
grep -oE '/assets/[a-zA-Z][a-zA-Z0-9._-]+\.js' /tmp/<site>_home.html | sort -u > /tmp/chunks.txt
while read p; do f=$(basename "$p"); curl -s -m 30 -A "$UA" "https://<site>$p" -o "$f" & done < /tmp/chunks.txt; wait
```
**坑：只抓首页 HTML 里的清单会漏掉 2/3**。chunk 之间互相 import，而且 import
常写**相对路径**（`from "./project-XXX.js"`，不带 `/assets/` 前缀）。
正确做法：抓完第一批后再从已下载文件里二次抽取，**迭代到不再新增**：
```bash
cat *.js /tmp/<site>_home.html | grep -ohE '[a-zA-Z][a-zA-Z0-9._-]+-[A-Za-z0-9_-]{8}\.js' \
  | grep -v '^chunk-' | sort -u | sed 's|^|/assets/|' > /tmp/chunks2.txt
# 补下载缺失的，再 repeat 一次直到 ls | wc -l 稳定
```
判据：下完的 chunk 里若出现首页没引用过的新组件名（如 `studio-`、`project-`），说明还没抓全。

### 3. 挖 API 基址与端点
```bash
grep -hoE 'https?://api\.[a-z0-9.-]+' *.js | sort -u          # 基址（常与主域不同！）
grep -hoE '`?/[a-zA-Z][a-zA-Z0-9/_-]{3,60}`?' *.js | sort -u | grep -iE 'prompt|template|keyword|inspire|canvas|list|page|detail|model'
```
椒图实战：主域 `jiaotu.ai`，但 API 在 **`api.jiaotuai.cn`**——不看 chunk 根本猜不到。

**黄金端点识别**（按与"提示词"的相关度排）：
- `*Templates/queryList`、`/prompt/*`、`/keyword/*`、`inspiration`、`canvasTools`
- 列表口带 `page/pageSize`，详情口带 `/detail/{id}`
- **提示词常在详情而非列表**——列表只给标题和图

### 4. 试鉴权（关键分岔）
前端 axios 封装里常直接写明鉴权要求，**先读源码再动手**：
```bash
grep -hoE '.{80}queryModels.{40}' *.js    # 找 { noAuth: true } 这类标记
```
- 标 `noAuth:true` 的端点 → **直接裸 GET 就能通**
- 没标的 → 先带 `Origin` + `Referer` 裸试一次；401/403 就换端点，**不要硬刚登录态**
- 试通一个口，就能顺藤摸瓜找同系列的列表口

**Windows 必坑**：`curl -d` 发中文会按 GBK 编码 → 服务端拿到乱码 → 0 命中。
测中文接口一律用 `python - <<'EOF'` + `urllib`，不要 git-bash curl。
（本技能默认用 python 收割，天然绕开这个坑）

### 5. 全量收割 + 落盘
```python
# 列表：先 pageSize=100 试能否一次拉全（total 字段对账，不够再翻页）
# 详情：逐条拉，0.2-0.3s 间隔防限流，异常单条跳过不中断
json.dump(out, open('D:/pi-workspace/文档/<平台>提示词库.json','w',encoding='utf-8'),
          ensure_ascii=False, indent=1)
```
**必须双份落盘**：JSON（可再加工）+ MD（可读，按场景分组 + 代码块收录原文）。
MD 里每条必须带：完整提示词原文 / 推荐模型 / 参数（比例等）/ 效果图链接。
现场用 `print(f"共 {len(data)} 条")` + 抽 3 条打印做**客观自检**，不要凭感觉宣布完成。

### 6. 顺手捞模型表与前端写死语料
- 模型表：找 `/queryModels` 类公开端点，拿 `id → 名称` 映射写进 MD（提示词常只存 modelId）
- **前端写死的示例语料**：首页轮播/占位提示词常硬编码在 chunk 里，不在接口里。
  搜法：`grep -oE '[a-z]{2}=\[(`[^`]*`(?:,`[^`]*`)*)\]'` 提取反引号数组，
  再按中文内容判断是不是示例提示词。**这是接口之外的第二富矿**（椒图 24 条示例全在这）。

## 复用资产（已验证脚本骨架）

收割脚本可直接改 URL 复用：`D:/pi-workspace/工程/_templates/扒站提示词-收割脚本.py`
（列表+详情双段、total 对账、限流、双份落盘、客观自检，全在里面）

## 已知语料库

- **Pavo（pavo-ai.cn，Next.js）**：短剧提示词 74 条
  `D:/pi-workspace/文档/pavo提示词库_打标签.json`（详见 short-drama-prompt-mining 技能）
- **椒图AI（jiaotu.ai，Vite/Rolldown）**：电商图提示词 57 条 + 首页示例 24 条
  `D:/pi-workspace/文档/jiaotu提示词库.md` + `D:/pi-workspace/文档/jiaotu提示词库.json`
  特点：有参数化模板语法 `{argument name="字段" default="默认"}`，20 条带参考图

## 铁律

1. **chunk 要迭代抓到收敛**——只抓首页清单必漏，import 相对路径是隐形入口
2. **API 基址看 chunk 不猜主域**——椒图就是 `jiaotuai.cn` 而非 `jiaotu.ai`
3. **先读 `noAuth` 标记再试鉴权**；401 换端点，不硬刚登录态
4. **提示词在详情不在列表**，必须逐条拉详情；列表只用来拿 id 和 total 对账
5. **前端写死的示例语料是第二富矿**，接口收完必须回头扫 chunk
6. 落盘 JSON + MD 双份，MD 每条带效果图链接（提示词离开画面没法验证）
7. **Windows 中文请求用 python 不用 curl**（GBK 坑已踩两次）
