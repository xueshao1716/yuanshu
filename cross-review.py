"""
pi-web 项目交叉审查：gpt-5.6-luna + claude-sonnet-5 via OpenRouter
两个模型独立审查同一份代码，最后交叉比对
"""
import json, urllib.request, urllib.error, time, os, sys

AUTH = json.load(open(r'C:\Users\xuexiaofeng\.pi\agent\auth.json', encoding='utf-8'))
OR_KEY = AUTH['openrouter']['key']

FILES = [
    'server.mjs',
    'engine/unified-chat.mjs',
    'engine/session-manager.mjs',
    'engine/session-sanitize.mjs',
    'engine/context-loader.mjs',
    'engine/model-keys.mjs',
    'engine/model-session.mjs',
    'engine/rate-limit.mjs',
    'engine/output-guard.mjs',
    'engine/sdk-providers.mjs',
    'engine/misc-api.mjs',
    'engine/session-bus.mjs',
    'engine/session-utils.mjs',
    'engine/workspace-api.mjs',
    'engine/http.mjs',
    'watchdog.cjs',
]

PROJECT_DIR = r'D:\pi-web'

# 收集文件内容
print('收集项目文件...')
code_parts = []
total_chars = 0
for f in FILES:
    fp = os.path.join(PROJECT_DIR, f)
    if os.path.exists(fp):
        content = open(fp, encoding='utf-8', errors='ignore').read()
        code_parts.append(f'// ══════ {f} ══════\n{content}')
        total_chars += len(content)
code_bundle = '\n\n'.join(code_parts)
print(f'已收集 {len(FILES)} 个文件，{total_chars:,} 字符 (~{total_chars//4:,} tokens)')

REVIEW_PROMPT = """你是一位资深全栈架构师，正在对 pi-web（一个 AI 工作台后端，Node.js + ESM）做全面代码审查。

请从以下维度逐一检查并给出具体发现（指明文件名+行号/函数名）：

1. **安全漏洞**：注入、权限绕过、路径遍历、密钥泄露、SSRF、未授权访问
2. **可靠性/稳定性**：未处理的异常、资源泄漏（fd/内存/定时器）、竞态条件、死锁
3. **架构问题**：职责混乱、循环依赖、全局状态污染、模块边界不清
4. **性能隐患**：阻塞操作、内存膨胀、无效重复计算、大文件同步读写
5. **逻辑 Bug**：条件判断错误、边界情况未覆盖、类型不安全
6. **代码质量**：重复代码、过长函数、命名不清、注释与实现不符
7. **缺失的防护**：应该有但没有的校验、限制、降级、日志

输出格式：
- 按严重程度排序（Critical > High > Medium > Low）
- 每条发现：[严重程度] 文件:位置 — 问题描述 — 建议修复
- 最后给一段整体评价（架构成熟度、最大风险、优先修复建议）

不要客气，不要泛泛而谈，要具体、可操作。"""

def call_openrouter(model, system, user, label):
    print(f'\n{"="*60}')
    print(f'调用 {label} ({model})...')
    body = json.dumps({
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ],
        'max_tokens': 16384,
        'temperature': 0.2,
    }).encode()
    req = urllib.request.Request(
        'https://openrouter.ai/api/v1/chat/completions',
        data=body,
        headers={
            'Authorization': 'Bearer ' + OR_KEY,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://pi.example.com',
            'X-Title': 'pi-web cross review',
        },
    )
    t0 = time.time()
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=600).read())
        text = resp['choices'][0]['message']['content']
        usage = resp.get('usage', {})
        elapsed = time.time() - t0
        print(f'✅ {elapsed:.1f}s | {usage.get("prompt_tokens",0):,} in / {usage.get("completion_tokens",0):,} out')
        return text
    except urllib.error.HTTPError as e:
        try: msg = json.loads(e.read()).get('error', {}).get('message', '')[:200]
        except: msg = ''
        print(f'❌ {e.code}: {msg}')
        return None
    except Exception as e:
        print(f'❌ {str(e)[:200]}')
        return None

# 并行（实际串行，避免 OpenRouter 限流）
gpt_review = call_openrouter(
    'openai/gpt-5.6-luna',
    REVIEW_PROMPT,
    f'以下是 pi-web 项目的完整后端代码：\n\n{code_bundle}',
    'GPT-5.6-Luna'
)

sonnet_review = call_openrouter(
    'anthropic/claude-sonnet-5',
    REVIEW_PROMPT,
    f'以下是 pi-web 项目的完整后端代码：\n\n{code_bundle}',
    'Claude Sonnet-5'
)

# 保存各自报告
out_dir = r'D:\pi-workspace\文档'
os.makedirs(out_dir, exist_ok=True)

if gpt_review:
    open(os.path.join(out_dir, 'review-gpt56.md'), 'w', encoding='utf-8').write(
        f'# GPT-5.6-Luna 代码审查报告\n\n> 生成时间：{time.strftime("%Y-%m-%d %H:%M")}\n\n{gpt_review}'
    )
    print(f'\nGPT 报告已保存: 文档/review-gpt56.md')

if sonnet_review:
    open(os.path.join(out_dir, 'review-sonnet5.md'), 'w', encoding='utf-8').write(
        f'# Claude Sonnet-5 代码审查报告\n\n> 生成时间：{time.strftime("%Y-%m-%d %H:%M")}\n\n{sonnet_review}'
    )
    print(f'\nSonnet 报告已保存: 文档/review-sonnet5.md')

# 交叉比对（用 sonnet-5 做裁判，对比两份报告）
if gpt_review and sonnet_review:
    cross_review = call_openrouter(
        'anthropic/claude-sonnet-5',
        '你是代码审查仲裁员。两位审查员分别对同一个项目提交了独立审查报告。请：\n'
        '1. 找出两份报告的**共识发现**（双方都提到的问题，可信度最高）\n'
        '2. 找出**独有发现**（只有一方提到的，标注来源）\n'
        '3. 找出**矛盾观点**（两方意见不同的，给出你的判断）\n'
        '4. 最终给出**按优先级排序的修复清单**（Top 10）\n'
        '输出中文，具体到文件和位置。',
        f'## GPT-5.6-Luna 的审查报告\n\n{gpt_review}\n\n---\n\n## Claude Sonnet-5 的审查报告\n\n{sonnet_review}',
        'Sonnet-5 交叉比对'
    )
    if cross_review:
        open(os.path.join(out_dir, 'review-cross.md'), 'w', encoding='utf-8').write(
            f'# 交叉审查比对报告\n\n> GPT-5.6-Luna × Claude Sonnet-5 | {time.strftime("%Y-%m-%d %H:%M")}\n\n{cross_review}'
        )
        print(f'\n交叉比对报告已保存: 文档/review-cross.md')

print('\n✅ 全部完成')
