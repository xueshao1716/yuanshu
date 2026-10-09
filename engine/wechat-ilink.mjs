// 腾讯 iLink Bot 协议客户端（微信私聊机器人）。
// 协议常量来自小语 2026-10-06 自己接通的桥（工程/ilink-weixin-bridge.mjs，参考 hermes-agent），
// 这里只管协议：扫码登录、长轮询收消息、发消息。会话、调度、落盘在 wechat-bridge.mjs。
import crypto from "node:crypto";
import fs from "node:fs/promises";

export const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const APP_ID = "bot";
const CHANNEL_VERSION = "2.2.0";
const CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0);
export const EP = {
  qr: "ilink/bot/get_bot_qrcode",
  qrStatus: "ilink/bot/get_qrcode_status",
  updates: "ilink/bot/getupdates",
  send: "ilink/bot/sendmessage",
  getUploadUrl: "ilink/bot/getuploadurl",
};
// 素材 CDN：图片先加密传到这个域，再拿 x-encrypted-param 拼进消息引用（2026-10-08 逆向官方 2.4.9）。
export const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";
export const LONG_POLL_MS = 35_000;
export const RATE_LIMITED = -2;
const API_TIMEOUT_MS = 15_000;
const MSG_TYPE_BOT = 2;
const MSG_STATE_FINISH = 2;
const ITEM_TEXT = 1;
const ITEM_IMAGE = 2;
const UPLOAD_TYPE_IMAGE = 1;
export const MAX_TEXT = 2000;
const UPLOAD_TIMEOUT_MS = 60_000; // 素材可能几 MB，比普通接口放宽
// 发图前把原图用随机 aeskey 做 AES-128-ECB 加密再上 CDN；密文按 16 字节块 PKCS#7 补齐，
// 报给 getUploadUrl 的 filesize 是密文尺寸、不是原图尺寸。
const aesEcbPaddedSize = (rawsize) => Math.ceil((rawsize + 1) / 16) * 16;
const aesEncryptEcb = (plaintext, key) => {
  const c = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([c.update(plaintext), c.final()]);
};

export function ilinkHeaders(token) {
  const h = {
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": CLIENT_VERSION,
    "X-WECHAT-UIN": crypto.randomBytes(4).toString("base64"),
  };
  if (token) { h.Authorization = `Bearer ${token}`; h.AuthorizationType = "ilink_bot_token"; }
  return h;
}

async function parse(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ret: -999, raw: text.slice(0, 200) }; }
}

export function createIlinkClient({ fetch: f = globalThis.fetch, base = ILINK_BASE } = {}) {
  const post = async (endpoint, payload, token, timeoutMs = API_TIMEOUT_MS, at = base) => parse(await f(`${at}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...ilinkHeaders(token) },
    body: JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } }),
    signal: AbortSignal.timeout(timeoutMs),
  }));
  const get = async (endpoint, timeoutMs = API_TIMEOUT_MS, at = base) => parse(await f(`${at}/${endpoint}`, {
    method: "GET", headers: ilinkHeaders(null), signal: AbortSignal.timeout(timeoutMs),
  }));
  const getUploadUrl = (payload, token, at) => post(EP.getUploadUrl, payload, token, API_TIMEOUT_MS, at);
  // CDN 上传走独立域名、不带 iLink 头，只发密文；成功响应头 x-encrypted-param 是后续下载参数。
  const uploadToCdn = async (cdnUrl, ciphertext) => {
    const res = await f(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    const downloadParam = res.headers.get("x-encrypted-param");
    if (!res.ok || !downloadParam) {
      const t = await res.text().catch(() => "");
      throw new Error(`CDN 上传失败 ${res.status} ${t.slice(0, 120) || "没拿到 x-encrypted-param"}`);
    }
    return downloadParam;
  };
  return {
    async fetchQr(at = base) {
      const r = await get(`${EP.qr}?bot_type=3`, LONG_POLL_MS, at);
      return { value: String(r.qrcode || ""), url: String(r.qrcode_img_content || "") };
    },
    qrStatus: (value, at = base) => get(`${EP.qrStatus}?qrcode=${encodeURIComponent(value)}`, LONG_POLL_MS, at),
    getUpdates: (token, cursor, at = base) => post(EP.updates, { get_updates_buf: cursor.buf || "", ack_token: cursor.ack || "" }, token, LONG_POLL_MS + 5000, at),
    async sendText(token, to, text, contextToken, at = base) {
      const msg = {
        from_user_id: "", to_user_id: to, client_id: crypto.randomUUID(),
        message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH,
        item_list: [{ type: ITEM_TEXT, text_item: { text: String(text).slice(0, MAX_TEXT) } }],
      };
      if (contextToken) msg.context_token = contextToken;
      return post(EP.send, { msg }, token, API_TIMEOUT_MS, at);
    },
    // 发送一张本地图片：读文件 → md5 → getUploadUrl → AES-128-ECB 加密 → 上 CDN → 拿 x-encrypted-param → 发 image_item。
    // aes_key 用 base64(hex 密钥文本)、mid_size 用密文字节数——这两处是逆向确认的官方编码，别改成原始密钥/原图尺寸。
    async sendImage(token, filePath, to, contextToken, at = base) {
      const plaintext = await fs.readFile(filePath);
      const rawsize = plaintext.length;
      const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
      const filesize = aesEcbPaddedSize(rawsize);
      const filekey = crypto.randomBytes(16).toString("hex");
      const aeskey = crypto.randomBytes(16);
      const up = await getUploadUrl({ filekey, media_type: UPLOAD_TYPE_IMAGE, to_user_id: to, rawsize, rawfilemd5, filesize, no_need_thumb: true, aeskey: aeskey.toString("hex") }, token, at);
      const uploadFullUrl = String(up.upload_full_url || "").trim();
      const uploadParam = up.upload_param;
      if (!uploadFullUrl && !uploadParam) throw new Error(`getUploadUrl 没返回上传地址: ${JSON.stringify(up).slice(0, 140)}`);
      const cdnUrl = uploadFullUrl || `${CDN_BASE}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
      const downloadParam = await uploadToCdn(cdnUrl, aesEncryptEcb(plaintext, aeskey));
      const imageItem = {
        type: ITEM_IMAGE,
        image_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"),
            encrypt_type: 1,
          },
          mid_size: filesize,
        },
      };
      const msg = { from_user_id: "", to_user_id: to, client_id: crypto.randomUUID(), message_type: MSG_TYPE_BOT, message_state: MSG_STATE_FINISH, item_list: [imageItem] };
      if (contextToken) msg.context_token = contextToken;
      const r = await post(EP.send, { msg }, token, API_TIMEOUT_MS, at);
      return { ...r, fileSize: rawsize, fileSizeCiphertext: filesize };
    },
  };
}

// getupdates 成功响应不带 ret，判据是 msgs 数组。
export const updatesOk = (r) => Array.isArray(r?.msgs) || r?.ret === 0;

// 只认真人私聊文本；群（@chatroom）和自己发的都不进对话。
export function normalizeMessage(message, selfId) {
  const sender = String(message?.from_user_id || "").trim();
  if (!sender || (selfId && sender === selfId)) return null;
  const items = Array.isArray(message.item_list) ? message.item_list : [];
  const text = items.filter((i) => i?.type === ITEM_TEXT).map((i) => i.text_item?.text || "").join("").trim();
  return {
    sender, text,
    isGroup: sender.endsWith("@chatroom"),
    itemTypes: items.map((i) => i?.type).join(","),
    contextToken: message.context_token || "",
  };
}

// 微信排版化（2026-10-07 升级）：微信不渲染 markdown，但纯文本也有版式——
// 把语法"翻译"成微信友好的 Unicode 版式，而不是剥光：
// 标题给层级（〖〗/▎/▸）、强调给「」、表格变竖式卡片、列表变 •/①、代码块变竖线框。
// 幂等：已转换文本再过一遍不变。
export function stripMarkdownForWechat(text) {
  if (!text || typeof text !== "string") return text || "";
  let t = text.replace(/\r\n?/g, "\n");
  const indent = (sp) => "　".repeat(Math.floor(sp.length / 2));
  // 1) 代码围栏 → 竖线框
  t = t.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    const lines = code.replace(/\n$/, "").split("\n").map((l) => `│ ${l}`);
    return ["┌──────", ...lines, "└──────"].join("\n");
  });
  t = t.replace(/```/g, "");
  // 2) 表格 → 竖式卡片：分隔行删；首行当表头；一行一条 ▪，多列逐行缩进
  t = t.replace(/(?:^[ \t]*\|[^\n]*(?:\n|$))+/gm, (block) => {
    const cells = block.trim().split("\n").map((l) => l.trim().replace(/\\\|/g, "\u0001").replace(/^\|/, "").replace(/\|[ \t]*$/, "").split("|").map((c) => c.trim().replace(/\u0001/g, "|")));
    const isSep = (row) => row.every((c) => c === "" || /^:?-{2,}:?$/.test(c));
    const body = cells.filter((r) => r.some((c) => c) && !isSep(r));
    if (!body.length) return "";
    if (body.length === 1) return body[0].filter(Boolean).map((v) => `• ${v}`).join("\n");
    const [head, ...data] = body;
    const card = data.map((row) => row.map((v, i) => (head[i] && v ? (i === 0 ? `▪ ${head[i]}：${v}` : `　${head[i]}：${v}`) : i === 0 ? `▪ ${v || "—"}` : v ? `　${v}` : "")).filter((l, i) => l || i === 0).join("\n")).join("\n\n");
    return card + "\n"; // 补尾换行：表格块吞掉了行尾 \n，不补会吃掉与下文的空行
  });
  // 3) 标题层级：## ▎、### ▸、# 〖〗（长在前防误吃），残留井号兜底删
  t = t.replace(/^[ \t]{0,3}##[ \t]+([^\n]+)$/gm, "▎$1");
  t = t.replace(/^[ \t]{0,3}###[ \t]+([^\n]+)$/gm, "▸ $1");
  t = t.replace(/^[ \t]{0,3}#[ \t]+([^\n]+)$/gm, "〖$1〗");
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  // 4) 行内代码、粗体、斜体（先代码再星号，防 `a*b` 误吞）
  t = t.replace(/`([^`\n]+)`/g, "「$1」");
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "「$1」").replace(/__([^_\n]+)__/g, "「$1」");
  t = t.replace(/(^|[\s，。；：（「」(【])\*([^*\n]+)\*/g, "$1$2").replace(/(^|[\s，。；：（「」(【])_([^_\n]+)_/g, "$1$2");
  // 5) 链接 [t](u) → t（u）
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）");
  // 6) 引用行 → ┃ 前缀
  t = t.replace(/^[ \t]{0,3}>+[ \t]?/gm, "┃ ");
  // 7) 分隔线 → 长横线
  t = t.replace(/^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "────────");
  // 8) 任务复选框 → ☐/☑（放无序列表前，避免被 • 吃掉）
  t = t.replace(/^([ \t]*)[-*+][ \t]+\[( |x|X)\][ \t]*/gm, (_, sp, m) => indent(sp) + (m.trim() ? "☑ " : "☐ "));
  // 9) 无序列表 → •（半角缩进两格折一全角）
  t = t.replace(/^([ \t]*)[-*+][ \t]+/gm, (_, sp) => indent(sp) + "• ");
  // 10) 有序列表 → ①②…⑳，超出保留数字
  t = t.replace(/^([ \t]*)(\d{1,3})[.、)][ \t]+/gm, (_, sp, n) => {
    const i = parseInt(n, 10);
    const circ = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
    return indent(sp) + (i >= 1 && i <= 20 ? circ[i - 1] + " " : `${i}. `);
  });
  // 11) 中文后的「去掉前导半角空格（中文排版引号前不留空格）
  t = t.replace(/([\u4e00-\u9fff，。；：、（」]) 「/g, "$1「");
  // 12) 压缩 3 行以上连续空行
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

// 微信单条上限 2000 字：长回复按段落切开，尽量不从句子中间断。
export function splitForWechat(text, limit = MAX_TEXT) {
  const out = [];
  let rest = String(text || "").trim();
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    let cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
    if (cut < limit * 0.5) cut = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"));
    if (cut < limit * 0.5) cut = limit - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}
