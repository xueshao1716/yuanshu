---
name: windows-shell-playbook
description: 当需要在 Windows 上跑命令、写含中文的文件、或批量改文件内容时用：GBK/UTF-8 编码与 cmd 引号转义的固定打法
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

1. **内联代码不写**：`node -e "…"`、`python -c "…"` 里只要有引号或换行就会被拆坏
   （典型报错 `const ^^^^`、`'C:\Program' 不是内部或外部命令`）。
   → 先**落成脚本文件**再跑（bash 工具会自动改写 `node -e`，但自己落文件更可控，也让 abort 能杀掉真进程）。
2. **路径带空格必须加引号**：`"C:\Program Files\nodejs\node.exe" -v`。
   不加引号会被 cmd 拆成 `C:\Program` + `Files\...`——而这个报错**不会**告诉你"是空格问题"。
3. **一个 argv 元素就是一段字符串**：`execFile(file, [a, b])` 别把两条命令塞进一个参数；
   要串联用 `&&` 写进**一个**字符串参数里。
4. **看到"不是内部或外部命令"先怀疑拆词/编码，不要先怀疑程序没装**：
   确认 shell 方言（cmd 还是 bash）、确认引号、确认代码页，再谈别的。

## 三、动手前的固定三问（30 秒，省几轮返工）

1. 这条命令里有**中文**吗？→ 有就改走 `write`/`read`/`edit` 工具，或 `chcp 65001` + 落文件。
2. 这条命令里有**引号/空格路径/内联代码**吗？→ 有就先落文件、加引号，别内联。
3. 失败信息指向的是**工具**还是**环境**？→ 环境问题（编码/引号/方言）要换打法，不是重试同一条命令。

## 四、速查

| 想做的事 | 正确打法 | 别用 |
| --- | --- | --- |
| 写含中文的文件 | `write` 工具 | echo 重定向、`Set-Content` |
| 批量替换文件内容 | Node 脚本（`fs` + `utf8`）落盘再跑 | `Get-Content \| Set-Content` |
| 跑一段 JS/Python | 先落成脚本文件再执行 | `node -e` 内联 |
| 调用带空格路径的程序 | `"C:\Program Files\…\x.exe"` | 裸路径 |
| 杀掉子进程 | 工具自带的 abort（会连孙子进程一起杀） | 只 kill shell |
