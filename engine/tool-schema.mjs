// 工具参数按声明的 JSON Schema 校验（FC 层）：拦住模型编造的参数，把可操作的错误回给模型自纠。
// 刻意宽松：只查 required / type / enum，允许多余字段；数字、布尔接受字符串形式；
// 遇到 anyOf/oneOf/allOf/$ref 的节点直接放行，避免对复杂 MCP schema 误杀。

const MAX_ERRORS = 5;

function typeOk(type, v) {
  switch (type) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
    case "integer": return typeof v === "number" ? Number.isInteger(v) : typeof v === "string" && /^-?\d+$/.test(v.trim());
    case "boolean": return typeof v === "boolean" || v === "true" || v === "false";
    case "array": return Array.isArray(v);
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function walk(schema, value, path, errors) {
  if (errors.length >= MAX_ERRORS || !schema || typeof schema !== "object") return;
  if (schema.anyOf || schema.oneOf || schema.allOf || schema.$ref) return;
  const types = schema.type ? [].concat(schema.type) : null;
  if (types && !types.some((t) => typeOk(t, value))) {
    errors.push(`${path} 应为 ${types.join("|")}，实际是 ${describe(value)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => e === value || String(e) === String(value))) {
    errors.push(`${path} 必须是 ${schema.enum.map((e) => JSON.stringify(e)).join("、")} 之一`);
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (value[key] === undefined || value[key] === null) errors.push(`${path === "参数" ? "" : path + "."}${key} 为必填`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined && value[key] !== null) walk(sub, value[key], `${path === "参数" ? "" : path + "."}${key}`, errors);
    }
  } else if (Array.isArray(value) && schema.items) {
    value.slice(0, 20).forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors));
  }
}

export function validateToolArgs(schema, args) {
  if (!schema || typeof schema !== "object") return { ok: true, errors: [] };
  const errors = [];
  const subject = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  walk({ ...schema, type: schema.type || "object" }, subject, "参数", errors);
  return { ok: errors.length === 0, errors };
}

export function toolSchemaIndex(toolDefs) {
  const index = new Map();
  for (const def of Array.isArray(toolDefs) ? toolDefs : []) {
    const fn = def?.function || def;
    if (fn?.name && fn.parameters && typeof fn.parameters === "object") index.set(fn.name, fn.parameters);
  }
  return index;
}

export function argsErrorText(name, errors) {
  return `[参数校验] 工具 ${name} 的参数不合法：${errors.join("；")}。请严格按工具定义补全或修正后重试，不要编造参数。`;
}
