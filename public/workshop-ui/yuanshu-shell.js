(() => {
  if (window.yuanshuCanvasReady) init();
  else window.addEventListener('yuanshu-canvas-ready', init, {once:true});
  function init() {
  const THEMES = {
    mist: { bg: "#f3f5fa", text: "#1c2333", accent: "#4a58fa" },
    kraft: { bg: "#e5d4aa", text: "#3b2c14", accent: "#b45309" },
    shuimo: { bg: "#F7F4EC", text: "#2A2620", accent: "#B54334" },
    bamboo: { bg: "#F1F5EC", text: "#233024", accent: "#3F7A50" },
    wood: { bg: "#E8D4B2", text: "#2A2118", accent: "#0B8A54" },
    deep: { bg: "#0e1116", text: "#e8eef8", accent: "#5468ff" },
    ink: { bg: "#050508", text: "#eceef2", accent: "#5468ff" },
    violet: { bg: "#0a0818", text: "#f0eaff", accent: "#8b7cf6" },
    sepia: { bg: "#171310", text: "#ede4d8", accent: "#d97706" },
    moss: { bg: "#0c120e", text: "#e2ece4", accent: "#3f9e6e" },
    azure: { bg: "#0a101c", text: "#e0eaff", accent: "#38bdf8" },
  };

  document.title = "元枢 · 界面工坊";
  document.documentElement.lang = "zh-CN";

  const token = () => { try { return localStorage.getItem("yuanshu_access_token") || localStorage.getItem("pi_web_token") || ""; } catch { return ""; } };
  const read = (k, fb = "") => { try { return localStorage.getItem(k) || fb; } catch { return fb; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

  try {
    const ui = JSON.parse(read("m3e:ui", "{}") || "{}");
    if (!ui.lang) write("m3e:ui", JSON.stringify({ ...ui, lang: "zh" }));
  } catch {}

  function applyTheme(theme, accent, wallpaper) {
    const seed = THEMES[theme] || THEMES.mist;
    const color = accent || seed.accent;
    const el = document.documentElement;
    el.dataset.theme = THEMES[theme] ? theme : "mist";
    el.style.setProperty("--pi-bg", seed.bg);
    el.style.setProperty("--pi-text", seed.text);
    el.style.setProperty("--pi-accent", color);
    el.style.setProperty("--pi-accent2", color);
    const wp = document.getElementById("yuanshu-wallpaper");
    if (wp) {
      const v = String(wallpaper || "").trim();
      const img = !v ? "" : /^(linear|radial|conic)-gradient\(/i.test(v) || /^url\(/i.test(v) ? v : `url(${JSON.stringify(v)})`;
      wp.style.backgroundImage = img;
      document.body.classList.toggle("has-wallpaper", !!img);
    }
  }

  function injectAi(modelKey) {
    write("m3e:ai", JSON.stringify({
      provider: "openai",
      baseUrl: `${location.origin}/api/workshop-ui/v1`,
      model: modelKey || "yuanshu",
      key: token(),
    }));
    window.yuanshuWorkshopModel = modelKey || "";
  }

  applyTheme(read("pi_theme", "mist"), read("pi_accent"), read("pi_wallpaper"));
  injectAi(read("yuanshu-ui-model"));
  let modelCache = null;

  function ensureChrome() {
    if (!document.body) return;
    if (!document.getElementById("yuanshu-wallpaper")) {
      const wp = document.createElement("div");
      wp.id = "yuanshu-wallpaper";
      document.body.prepend(wp);
    }
    if (!document.getElementById("yuanshu-bar")) {
      const bar = document.createElement("header");
      bar.id = "yuanshu-bar";
      bar.innerHTML = '<a id="yuanshu-back" href="/#/workshop" target="_top" rel="noreferrer">返回创作</a><div class="brand"><i>元</i><strong>元枢</strong><span>界面工坊</span></div><label class="yuanshu-model">模型 <select id="yuanshu-model" class="yuanshu-model-select"><option value="">加载中…</option></select></label>';
      bar.querySelector("#yuanshu-back").addEventListener("click", () => {
        try {
          sessionStorage.removeItem("yuanshu-open-ui");
          localStorage.setItem("pi_workshop_tab", "ui");
        } catch {}
      });
      document.body.prepend(bar);
    }
    applyTheme(read("pi_theme", "mist"), read("pi_accent"), read("pi_wallpaper"));
    if (modelCache) fillModels(modelCache);
  }
  ensureChrome();
  setTimeout(ensureChrome, 200);
  setTimeout(ensureChrome, 800);
  new MutationObserver(() => { if (!document.getElementById("yuanshu-bar")) ensureChrome(); }).observe(document.documentElement, { childList: true, subtree: true });

  const keepTitle = () => {
    if (document.title !== "元枢 · 界面工坊") document.title = "元枢 · 界面工坊";
  };
  keepTitle();
  setTimeout(keepTitle, 400);
  new MutationObserver(keepTitle).observe(document.querySelector("title") || document.head, { childList: true, subtree: true, characterData: true });

  function isText(m) {
    const cap = m.capabilities;
    const keys = Array.isArray(cap) ? cap : Object.entries(cap || {}).filter(([, v]) => v).map(([k]) => k);
    return !keys.includes("image") && !keys.includes("video");
  }

  function hideOfficialAi() {
    const labels = new Set(["服务商", "基础 URL", "API 密钥", "模型 ID", "Provider", "Base URL", "API key", "Model ID"]);
    for (const el of document.querySelectorAll(".app-root div")) {
      if (el.children.length > 2) continue;
      if (labels.has((el.textContent || "").trim())) {
        const box = el.parentElement;
        if (box && box !== document.body) box.style.display = "none";
      }
    }
  }

  function mountAiPanel() {
    if (document.getElementById("yuanshu-ai-panel")) return;
    const heading = [...document.querySelectorAll(".app-root div")].find((el) =>
      ["AI 设置", "AI settings", "AI の設定"].includes((el.textContent || "").trim())
    );
    if (!heading) return;
    const box = document.createElement("div");
    box.id = "yuanshu-ai-panel";
    box.innerHTML = '<p>已接元枢通道，不用填官方 Key。</p><label>模型 <select class="yuanshu-model-select"><option value="">加载中…</option></select></label><p class="hint">辅助设计在画布上：点「让 AI 来画」写你要的界面，会画到画布上。右侧「提示词」是导出给编码用的。没有模型就先到元枢「模型与通道」添加。</p>';
    (heading.parentElement || heading).appendChild(box);
    if (modelCache) fillModels(modelCache);
  }

  function syncOfficialAi() {
    hideOfficialAi();
    mountAiPanel();
  }
  new MutationObserver(syncOfficialAi).observe(document.documentElement, { childList: true, subtree: true });

  const headers = () => ({ Authorization: `Bearer ${token()}` });
  fetch("/api/theme-prefs", { headers: headers() }).then((r) => r.ok ? r.json() : null).then((d) => {
    if (!d) return;
    if (d.theme) write("pi_theme", d.theme);
    if (typeof d.accent === "string") write("pi_accent", d.accent);
    if (typeof d.wallpaper === "string") write("pi_wallpaper", d.wallpaper);
    applyTheme(d.theme || read("pi_theme", "mist"), d.accent || read("pi_accent"), d.wallpaper || read("pi_wallpaper"));
  }).catch(() => {});

  function fillModels(d) {
    const sels = [...document.querySelectorAll(".yuanshu-model-select")];
    if (!sels.length || !d) return;
    const models = (d.models || []).filter(isText);
    const current = d.current ? `${d.current.provider}/${d.current.id}` : "";
    const saved = read("yuanshu-ui-model");
    const pick = models.some((m) => `${m.provider}/${m.id}` === saved) ? saved : (models.some((m) => `${m.provider}/${m.id}` === current) ? current : (models[0] ? `${models[0].provider}/${models[0].id}` : ""));
    for (const sel of sels) {
      sel.replaceChildren(...(models.length ? models.map(m => new Option(`${m.name || m.id}（${m.provider}）${m.free ? ' · 免费' : ''}`, `${m.provider}/${m.id}`)) : [new Option('没有可用文本模型', '')]));
      sel.value = pick;
      sel.onchange = () => {
        write("yuanshu-ui-model", sel.value);
        injectAi(sel.value);
        for (const other of document.querySelectorAll(".yuanshu-model-select")) {
          if (other !== sel) other.value = sel.value;
        }
      };
    }
    if (pick) {
      write("yuanshu-ui-model", pick);
      injectAi(pick);
    }
  }
  fetch("/api/models", { headers: headers() }).then((r) => { if (!r.ok) throw new Error(r.status === 401 ? '请返回元枢登录' : '模型列表加载失败'); return r.json(); }).then((d) => {
    modelCache = d || { models: [] };
    fillModels(modelCache);
  }).catch((error) => {
    for (const sel of document.querySelectorAll(".yuanshu-model-select")) sel.replaceChildren(new Option(error.message, ''));
  });
  }
})();
