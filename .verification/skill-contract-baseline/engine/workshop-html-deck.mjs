import fs from "node:fs";
import path from "node:path";

/**
 * Load a generated HTML deck and always leave a canonical deck.json behind.
 * Agents are allowed to omit the manifest (or write a malformed one), so the
 * pages directory is the recovery source of truth. Keeping this in one helper
 * prevents the delivery/history path from failing after a successful render.
 */
export function loadAndPersistDeck(workDir, { verb = "对照", fsMod = fs } = {}) {
  const deckPath = path.join(workDir, "deck.json");
  let deck = null;
  try {
    if (fsMod.existsSync(deckPath)) {
      const raw = JSON.parse(fsMod.readFileSync(deckPath, "utf8"));
      if (Array.isArray(raw)) deck = { verb, slides: raw };
      else if (raw && typeof raw === "object") {
        deck = { ...raw };
        if (!String(deck.verb || "").trim()) deck.verb = verb;
        if (!Array.isArray(deck.slides) && Array.isArray(deck.pages)) deck.slides = deck.pages;
      }
    }
  } catch {
    deck = null;
  }

  let list = Array.isArray(deck?.slides) ? deck.slides : [];
  if (!list.length) {
    try {
      const pagesDir = path.join(workDir, "pages");
      if (fsMod.existsSync(pagesDir)) {
        const names = fsMod.readdirSync(pagesDir)
          .filter((name) => String(name).toLowerCase().endsWith(".html"))
          .sort();
        if (names.length) {
          deck = { ...(deck && typeof deck === "object" ? deck : {}), verb, slides: names.map((name) => ({
            file: `pages/${name}`,
            title: name.replace(/\.html$/i, ""),
            layout: "",
          })) };
          list = deck.slides;
        }
      }
    } catch {
      // Keep an empty result; the caller will report that no deck was found.
    }
  }

  if (deck && list.length) {
    try { fsMod.writeFileSync(deckPath, JSON.stringify(deck, null, 2), "utf8"); } catch {}
  }
  return { deck, list, deckPath };
}
