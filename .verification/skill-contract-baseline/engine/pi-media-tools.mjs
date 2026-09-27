// pi 主驾的宿主媒体工具：和统一通道同一套密文执行器，首轮就能出片。
import { MEDIA_TOOL_SCHEMAS, createMediaToolExecutor } from "./media-channels.mjs";

export const PI_MEDIA_TOOL_NAMES = MEDIA_TOOL_SCHEMAS.map((s) => s.function.name);

function typeboxField(Type, spec, required) {
  const desc = { description: spec?.description || "" };
  const base = spec?.type === "string" ? Type.String(desc) : Type.Any(desc);
  return required ? base : Type.Optional(base);
}

export function createPiMediaTools({ Type, generateMediaAsync, getModelList } = {}) {
  if (!Type) return [];
  const exec = createMediaToolExecutor({ generateMediaAsync, getModelList });
  return MEDIA_TOOL_SCHEMAS.map((s) => {
    const name = s.function.name;
    const props = s.function.parameters?.properties || {};
    const required = new Set(s.function.parameters?.required || []);
    const fields = {};
    for (const [k, v] of Object.entries(props)) {
      fields[k] = typeboxField(Type, v, required.has(k));
    }
    return {
      name,
      label: s.function.description.slice(0, 32),
      description: s.function.description,
      parameters: Type.Object(fields),
      async execute(_id, params) {
        const r = await exec(name, params || {});
        return {
          content: [{ type: "text", text: String(r?.text || "") }],
          details: r?.media ? { media: r.media } : undefined,
          isError: r?.isError === true,
        };
      },
    };
  });
}
