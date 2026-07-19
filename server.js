import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const app = express();
const PORT = process.env.PORT || 3000;
const LADDER_URL = process.env.LADDER_URL || "https://ladder-bueno.theworkpc.com";

function firstUrlFromSrcset(srcset) {
  if (!srcset) return null;
  return srcset.split(",")[0].trim().split(" ")[0] || null;
}

app.get("/read", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Paramètre 'url' manquant");

  try {
    const proxied = `${LADDER_URL}/${targetUrl}`;
    const response = await fetch(proxied, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await response.text();

    const dom = new JSDOM(html, { url: targetUrl });
    const document = dom.window.document;

    // --- Corrige les images lazy-load / picture / background-image AVANT extraction ---
    document.querySelectorAll("img").forEach(img => {
      const current = img.getAttribute("src");
      if (!current || current.startsWith("data:")) {
        const lazy = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") ||
                     img.getAttribute("data-original") || img.getAttribute("data-lazy");
        const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
        const fromSrcset = firstUrlFromSrcset(srcset);
        const finalSrc = lazy || fromSrcset;
        if (finalSrc) img.setAttribute("src", finalSrc);
      }
    });
    document.querySelectorAll("picture").forEach(pic => {
      const img = pic.querySelector("img");
      const source = pic.querySelector("source[srcset]");
      if (img && source) {
        const current = img.getAttribute("src");
        if (!current || current.startsWith("data:")) {
          const url = firstUrlFromSrcset(source.getAttribute("srcset"));
          if (url) img.setAttribute("src", url);
        }
      }
    });
    document.querySelectorAll('[style*="background-image"]').forEach(el => {
      const style = el.getAttribute("style") || "";
      const match = style.match(/background-image:\s*url\(['"]?([^'")]+)['"]?\)/i);
      if (match && !el.querySelector("img")) {
        const img = document.createElement("img");
        img.setAttribute("src", match[1]);
        el.prepend(img);
      }
    });
    document.querySelectorAll("noscript").forEach(ns => {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = ns.textContent;
      if (wrapper.querySelector("img")) ns.replaceWith(wrapper);
    });

    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) return res.status(500).send("Impossible d'extraire le contenu de cet article.");

    const contentDom = new JSDOM(`<div id="root">${article.content}</div>`);
    const root = contentDom.window.document.getElementById("root");

    // Supprime les styles inline (empêche les cartes Twitter/X de forcer un fond blanc)
    root.querySelectorAll("[style]").forEach(el => el.removeAttribute("style"));

    // Supprime les blocs promo/cookie textuels courts (jamais s'ils contiennent image/tweet/iframe)
    const junkPatterns = /cookies et autres traceurs|Ce contenu est bloqué|opéré par (Twitter|Meta|Google|TikTok)|retirer votre consentement|Politique cookies|manquer aucune actualité|suivez-nous sur|écran d.accueil|en un clin d.œil|restez connectés/i;
    root.querySelectorAll("p, div").forEach(el => {
      const text = el.textContent.trim();
      if (text.length < 500 && junkPatterns.test(text) && !el.querySelector("img, figure, iframe, blockquote")) {
        el.remove();
      }
    });

    // Supprime les blocs de fin sans aucun texte (rangées d'icônes, badges d'app) - s'arrête au premier vrai texte rencontré
    let trailing = Array.from(root.children);
    for (let i = trailing.length - 1; i >= 0; i--) {
      if (trailing[i].textContent.trim().length === 0) {
        trailing[i].remove();
      } else {
        break;
      }
    }

    const cleanedContent = root.innerHTML;

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 680px; margin: 60px auto; padding: 0 24px; font-family: -apple-system, "SF Pro Text", "Georgia", serif; font-size: 20px; line-height: 1.65; letter-spacing: 0.01em; color: #1a1a1a; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #1c1c1e; } a { color: #6cb2eb; } }
  h1 { font-family: -apple-system, "SF Pro Display", "Georgia", serif; font-size: 2em; font-weight: 700; line-height: 1.25; margin-bottom: 0.3em; letter-spacing: -0.01em; }
  .byline { font-family: -apple-system, sans-serif; color: #86868b; font-size: 0.85em; margin-bottom: 2.5em; text-transform: uppercase; letter-spacing: 0.05em; }
  p { margin: 1.4em 0; }
  img { max-width: 100%; height: auto; border-radius: 10px; margin: 1.5em 0; display: block; }
  figcaption { font-size: 0.8em; color: #86868b; text-align: center; margin-top: -1em; margin-bottom: 1.5em; }
  a { color: #0066cc; text-decoration: none; border-bottom: 1px solid rgba(0,102,204,0.3); }
  blockquote {
    margin: 2em 0;
    padding: 1.2em 1.4em;
    background: rgba(0,0,0,0.04);
    border-left: none;
    border-radius: 14px;
    font-style: normal;
    font-size: 0.95em;
    color: inherit;
  }
  @media (prefers-color-scheme: dark) { blockquote { background: rgba(255,255,255,0.07); } }
  blockquote p { margin: 0.5em 0; }
  blockquote a { color: inherit; }
  hr { border: none; border-top: 1px solid rgba(0,0,0,0.1); margin: 2.5em 0; }
</style>
</head>
<body>
  <h1>${article.title}</h1>
  <div class="byline">${article.byline || ""} ${article.siteName ? "· " + article.siteName : ""}</div>
  ${cleanedContent}
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Erreur : " + err.message);
  }
});

app.listen(PORT, () => console.log(`Reader server running on port ${PORT}`));