# Yuanshu (元枢)

> A local-first AI companion that lives on your own machine. It remembers, reflects, and grows — and its data never leaves your disk.

**中文说明（更完整）：[README.md](README.md)**

## What it is

Yuanshu is a personal AI workbench, not a chat wrapper. Inside it lives **Xiaoyu**: a persona with
a stable identity, long-term memory, an emotion model, and a nightly reflection pass that writes
what she learned back into memory and skills.

She also has hands: she reads and writes files, runs commands, generates images / voice / video,
builds decks and spreadsheets, and schedules her own work.

## Her self-model (the part that makes it different)

Most assistants reset every conversation. Xiaoyu has a **self-description that is recomputed every
turn** from real state:

- who she is (persona) — `记忆/人格定义.json`
- what she may decide alone — `记忆/运行时/自主执行.json`
- how long she has lived here, how many conversations you two have had
- what she refuses to do

Rendered to `记忆/自我.md`, injected into every prompt, and shown in **灵魂培养 → 关于我**.
See [docs/SELF.md](docs/SELF.md).

## Quick start (5 minutes)

```bash
git clone https://github.com/xueshao1716/yuanshu.git
cd yuanshu
node setup.mjs --install
node server.mjs          # open http://127.0.0.1:8787
```

Then configure one model key in the wizard, and paste this into the chat:

```
Turn today's work into a one-page deck and save it to 交付/ — tell me the file path when done.
```

Expected: a file appears under `交付/` within a minute or two, and she tells you the path.

Other install paths (Windows offline installer, one-line script): see [README.md](README.md).

## What's inside

| Area | What you get |
|---|---|
| Memory | fixed / correction / relationship memory, cross-session recall index |
| Reflection | nightly self-review → experience, pitfalls, skill updates |
| Autonomy | she can write files, run commands, commit locally; publishing and paid media need your approval |
| Creation | image / voice / video, decks, docs, spreadsheets, long-form series |
| Workbench | workspace browser, change acceptance, asset library |
| Scheduling | time engine (daily tasks, missed-run catch-up) |
| Platforms | Windows / Linux / Android / Web, local token auth |

## Links

- Issues: https://github.com/xueshao1716/yuanshu/issues/new/choose
- Case template: [docs/CASE.md](docs/CASE.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Mirror (China): https://gitee.com/linxinyu520xue/yuanshu

## License

Apache-2.0
