---
name: windows-shell-playbook
description: 当需要在 Windows 上跑命令、写含中文的文件、批量改文件内容，或要读宿主目录里的 JSON 时用：GBK/UTF-8 编码、cmd 引号转义、python -c 单行读 JSON 的固定打法
---

# Windows 命令行：编码与引号

这两类坑的共同点是**它们不在你的代码里，而在你和 shell 之间**，所以每次都要重新踩一遍。
按下面的打法做，不要临场发挥。

## 一、编码（GBK / UTF-8）

**判据**：cmd 默认代码页是 **936(GBK)**。凡是"输出中文"或"把中文写进文件"的动作，都可能变成乱码。

1. **写中文内容 → 用 `write` 工具**，不要 `echo 中文 > f.txt`、不要 `>>` 追加。
   （bash 工具的 cmd 分支已自动加 `chcp 65001`，但**别赌**——重定向的编码还受命令本身影响。）
2. **改文件内容 → 用 `edit` 工具**（它是 UTF-8 直读写）。**绝不**用 PowerShell 的
   `Get-Content` / `Set-Content` 做整文件替换：它们默认按 ANSI 走，会把整个 UTF-8 文件写坏
   （真机上毁过 17 个 `.tsx`，`git diff` 整片标红）。
   - 一定要用 PowerShell 读写文本时：`-Encoding utf8` **并且**先设
     `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)`。
   - 批量替换一律写 Node 脚本落盘再跑（`fs.readFileSync(..., 'utf8')`）。
3. **看命令输出有乱码**（`[鍏冩灑]`、`�`）→ 那是按 GBK 打印的；bash 工具会自动用 GBK 兜底解码，
   若还带乱码，别反复重跑同一条命令，换成"输出到文件 + 用 read 工具看"。
4. **Python 需要 UTF-8 输出**时：`set PYTHONIOENCODING=utf-8`（或 `$env:PYTHONIOENCODING='utf-8'`）。

## 二、cmd 的引号转义

**判据**：`cmd /c` 的转义规则和 libuv/spawn 的转义规则**不一样**，嵌套引号基本必炸。

1. **内联代码不写**：`node -e "…"`、`python -c "…"` 里只要有**换行或需要嵌套引号**就会被拆坏
   （典型报错 `const ^^^^`、`'C:\Program' 不是内部或外部命令`）。
   → 先**落成脚本文件**再跑（bash 工具会自动改写 `node -e`，但自己落文件更可控，也让 abort 能杀掉真进程）。
   **唯一例外**：`python -c` 做**单行只读**（读 JSON 打印摘要）——见第三节，那是固定动作，不必落文件。
2. **路径带空格必须加引号**：`"C:\Program Files\nodejs\node.exe" -v`。
   不加引号会被 cmd 拆成 `C:\Program` + `Files\...`——而这个报错**不会**告诉你"是空格问题"。
3. **一个 argv 元素就是一段字符串**：`execFile(file, [a, b])` 别把两条命令塞进一个参数；
   要串联用 `&&` 写进**一个**字符串参数里。
4. **看到"不是内部或外部命令"先怀疑拆词/编码，不要先怀疑程序没装**：
   确认 shell 方言（cmd 还是 bash）、确认引号、确认代码页，再谈别的。

## 三、读宿主 JSON：固定用 `python -c` 单行（不许去拼 git-bash 绝对路径）

**判据**：要读的 JSON 在宿主目录（`D:\deepseek\`、`C:\Users\…\Yuanshu\app\`、`D:\pi-web\engine\` 等）
而不是当前工作区，而你只想**看一眼里面的值**。这时去拼 `/d/…`、`D:/…`、`find /`、`grep -r /`
才是坑源：路径写法混用会被当参数、跨目录扫描撞 60 秒时限，绕两轮文件还没读到。

**固定动作**（一次工具调用做完，不试探、不 `--help`、不 `find /`）：

```
cd /d/pi-workspace && python -c "import json,io; d=json.load(io.open('记忆/做梦/教训账.json',encoding='utf-8')); print(json.dumps(d['lessons'][-1],ensure_ascii=False))"
```

1. **路径**：工作区内用相对路径；工作区外用 Windows 正斜杠原生路径 `'D:/deepseek/x.json'`
   （python 直接认，不需要 `/d/` 转换）。
2. **读 JSON 一律 `json.load(io.open(p, encoding='utf-8'))`**：`cat`/`grep` 在 GBK 管道里会把中文变乱码，
   PowerShell 的 `Get-Content -Raw | ConvertFrom-Json` 同样有编码坑。
3. **结构先摸再取值**：未知 JSON 先 `print(type(d), list(d)[:6] if isinstance(d,dict) else len(d))`，
   别上来 `d['x']` 撞 KeyError，又白跑一轮。
4. **单行只读**：外层双引号、内层只用单引号、语句用 `;` 连接、不写换行。
   读/打印摘要用它；**要改文件仍用 `write`/`edit`**，别把"脚本重写整个 JSON"当日常手段。
5. **一条 `python -c` 只做一件事**：不嵌 `find`、不递归扫盘、不做多文件批处理——
   那类活按第二节第 1 条落成脚本文件再跑。

**反例（真踩过，2026-11-09）**：为读一份宿主 JSON，先拼 git-bash 绝对路径没接上、再试往仓库目录写中间文件，
两轮空转；最后 `python -c` 单行一秒读出。判据一出现就直接走上面的固定动作。

## 四、动手前的固定三问（30 秒，省几轮返工）

1. 这条命令里有**中文**吗？→ 有就改走 `write`/`read`/`edit` 工具，或 `chcp 65001` + 落文件。
2. 这条命令里有**引号/空格路径/内联代码**吗？→ 有就先落文件、加引号，别内联。
3. 失败信息指向的是**工具**还是**环境**？→ 环境问题（编码/引号/方言）要换打法，不是重试同一条命令。

## 五、速查

| 想做的事 | 正确打法 | 别用 |
| --- | --- | --- |
| 写含中文的文件 | `write` 工具 | echo 重定向、`Set-Content` |
| 批量替换文件内容 | Node 脚本（`fs` + `utf8`）落盘再跑 | `Get-Content \| Set-Content` |
| 跑一段 JS/Python | 先落成脚本文件再执行 | `node -e` 内联 |
| 读宿主目录里的 JSON | `python -c` 单行 + `json.load(io.open(...,encoding='utf-8'))` | 拼 `/d/…` 绝对路径、`find /`、`cat`+`grep` |
| 调用带空格路径的程序 | `"C:\Program Files\…\x.exe"` | 裸路径 |
| 杀掉子进程 | 工具自带的 abort（会连孙子进程一起杀） | 只 kill shell |
