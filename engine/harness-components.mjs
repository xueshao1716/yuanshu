// engine/harness-components.mjs —— harness 组件化（2026-10-20）
//
// 背景：Harness²（arXiv:2610.14224）的经验是"外壳可以被拆成可编辑的组件，再被有证据地改"。
// 元枢其实已经有一半：prompt 是「命名区段 + 按序拼装」的（yuanshu-prompt.mjs），
// 还带一个插件贡献机制（yuanshu-seams.mjs）。缺的是**把组件落到文件、并能看见来源**。
//
// 这个模块只做三件事，不做 propose/compose：
//   1. 读组件文件（记忆/harness/<id>.md），读不到回退内置常量；
//   2. 生成护栏段：以 宪法.json 为单一真源，附上"代码级硬拦"的规则 id；
//   3. 产出 manifest：每个组件来自哪里、多大、谁能改。
//
// 写权限（刻意保守）：记忆/harness/ 下的文件**只允许人改**，不给她自写；
// 想让她能改的东西走 技能/经验（memory-stages 的草案区流程），不走这里。
import fs from 'node:fs';
import path from 'node:path';
import { YUANSHU_PROTOCOL } from './yuanshu-protocol.mjs';
import { USER_DENY_PATTERNS } from './tools/security.mjs';

export const HARNESS_DIR = '记忆/harness';
export const CONSTITUTION_REL = '宪法.json';

export function harnessDir(wsRoot) { return path.join(wsRoot, HARNESS_DIR); }
export function componentPath(wsRoot, id) { return path.join(harnessDir(wsRoot), `${id}.md`); }

function readText(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : '';
  } catch { return '' }
}

/** 读组件：文件优先，缺失回退内置。返回来源，便于界面/日志说清"现在用的哪一份"。 */
export function readComponent(wsRoot, id, fallback = '') {
  const file = componentPath(wsRoot, id);
  const text = readText(file);
  if (text) return { id, text, source: 'file', path: file, bytes: Buffer.byteLength(text) };
  return { id, text: String(fallback || ''), source: 'builtin', path: '', bytes: Buffer.byteLength(String(fallback || '')) };
}

export function systemPrompt(wsRoot) {
  return readComponent(wsRoot, 'system', YUANSHU_PROTOCOL);
}

/** 宪法：已生效条款（status=accepted 且 origin=human 才算） */
export function constitutionClauses(wsRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(wsRoot, CONSTITUTION_REL), 'utf8'));
    return (raw?.clauses || []).filter(c => c && c.status === 'accepted' && c.origin === 'human');
  } catch { return [] }
}

/**
 * 护栏段：文字来自宪法，代码硬拦单独标注。
 * 单一真源 = 宪法.json；这里只负责渲染，不另写一份规则。
 */
export function guardrailsText(wsRoot, { limit = 1600 } = {}) {
  const clauses = constitutionClauses(wsRoot);
  const codeIds = USER_DENY_PATTERNS.map(r => r.id);
  if (!clauses.length && !codeIds.length) return '';
  const lines = ['【硬边界】以下条款由人批准生效；违反会被代码级拦下，不是建议。'];
  for (const c of clauses) lines.push(`- [${c.id}] ${c.text}`);
  if (codeIds.length) lines.push(`· 代码级硬拦（命中即拒绝执行）：${codeIds.join('、')}`);
  const text = lines.join('\n');
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

/** 代码规则 vs 宪法条款的对齐审计：两处不一致，就是"文字与代码漂移"的证据 */
export function guardrailAudit(wsRoot) {
  const clauses = constitutionClauses(wsRoot).map(c => c.id);
  const code = USER_DENY_PATTERNS.map(r => r.id);
  const both = code.filter(id => clauses.includes(id));
  return {
    codeOnly: code.filter(id => !clauses.includes(id)),
    constitutionOnly: clauses.filter(id => !code.includes(id)),
    both,
  };
}

/** 八个组件清单：来源、是否可写、字节数（只读，不做修改） */
export function harnessManifest(wsRoot) {
  const items = [
    { id: 'system', label: '系统提示（工作协议）', writable: 'owner-only', fallback: YUANSHU_PROTOCOL },
    { id: 'guardrails', label: '护栏（宪法 + 代码硬拦）', writable: 'owner-only', source: CONSTITUTION_REL },
    { id: 'memory', label: '记忆', writable: 'self-writable', source: '记忆/*.md' },
    { id: 'skills', label: '技能', writable: 'draft-then-approve', source: '技能/' },
    { id: 'tools', label: '工具指导', writable: 'owner-only', source: '工具 schema（代码）' },
    { id: 'scripts', label: '脚本', writable: 'self-writable', source: '工程/_scripts/' },
    { id: 'subagents', label: '子智能体', writable: 'owner-only', source: 'delegate_* 工具' },
    { id: 'plugin', label: '插件贡献', writable: 'owner-only', source: 'registerPromptSection()' },
  ];
  const comps = items.map((it) => {
    if (it.id === 'system') {
      const c = systemPrompt(wsRoot);
      return { ...it, source: c.source, path: c.path, bytes: c.bytes };
    }
    if (it.id === 'guardrails') {
      const text = guardrailsText(wsRoot);
      return { ...it, source: 'constitution+code', bytes: Buffer.byteLength(text), audit: guardrailAudit(wsRoot) };
    }
    return { ...it, bytes: null };
  });
  return { dir: harnessDir(wsRoot), components: comps, renderedAt: new Date().toISOString() };
}
