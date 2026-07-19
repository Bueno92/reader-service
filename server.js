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

function isVisuallyEmpty(node) {
  const text = node.textContent.replace(/[\s\u00A0]/g, "");
  const hasRealMedia = node.querySelector("img, iframe, blockquote, video");
  return text.length === 0 && !hasRealMedia;
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

    // Récupère l'image de couverture via og:image AVANT extraction (filet de sécurité universel)
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
                     document.querySelector('meta[name="twitter:image"]')?.getAttribute("content");

    // Corrige les images en lazy-load (data-src, srcset, picture, background-image)
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

    // Résout tout chemin d'image relatif restant, en se basant sur l'URL originale
    document.querySelectorAll("img").forEach(img => {
      const src = img.getAttribute("src");
      if (src && !/^(https?:|data:)/i.test(src)) {
        try {
          img.setAttribute("src", new URL(src, targetUrl).href);
        } catch (e) { /* ignore une URL invalide */ }
      }
    });

    const reader = new Readability(document);
    const article = reader.parse();

    if (!article) return res.status(500).send("Impossible d'extraire le contenu de cet article.");

    const contentDom = new JSDOM(`<div id="root">${article.content}</div>`);
    const root = contentDom.window.document.getElementById("root");

    // Supprime les styles inline (sauf sur les SVG, pour préserver les jauges/graphiques vectoriels)
    root.querySelectorAll("[style]:not(svg):not(svg *)").forEach(el => el.removeAttribute("style"));

    // Supprime les widgets de formulaire (newsletter, recherche, etc.)
    root.querySelectorAll("form, input, button, select, textarea").forEach(el => el.remove());

    // Supprime les tables des matières auto-générées (listes de liens d'ancrage internes uniquement)
    root.querySelectorAll("ul, ol").forEach(list => {
      const links = list.querySelectorAll("a");
      const listItems = list.querySelectorAll("li");
      if (links.length > 0 && links.length >= listItems.length) {
        const allAnchors = Array.from(links).every(a => (a.getAttribute("href") || "").startsWith("#"));
        if (allAnchors) list.remove();
      }
    });

    // Supprime les blocs promo/cookie textuels (jamais s'ils contiennent image/tweet/iframe)
    const junkPatterns = /cookies et autres traceurs|Ce contenu est bloqué|opéré par (Twitter|Meta|Google|TikTok)|retirer votre consentement|Politique cookies|manquer aucune actualité|suivez-nous sur|écran d.accueil|en un clin d.œil|restez connectés|édito exclusif|Inscrivez-vous gratuitement|newsletter tech|ToujoursPlus/i;
    root.querySelectorAll("p, div").forEach(el => {
      const text = el.textContent.trim();
      if (junkPatterns.test(text) && !el.querySelector("img, figure, iframe, blockquote")) {
        el.remove();
      }
    });

    // Détecte et restyle les blocs "On aime / On aime moins" (motif générique, tous sites)
    const prosPattern = /^(on aime|avantages|les \+|points forts)\s*:?$/i;
    const consPattern = /^(on aime moins|inconvénients|les -|points faibles)\s*:?$/i;

    const headings = Array.from(root.querySelectorAll("h1, h2, h3, h4, strong"));
    let prosHeading = headings.find(h => prosPattern.test(h.textContent.trim()));
    let consHeading = headings.find(h => consPattern.test(h.textContent.trim()));

    if (prosHeading && consHeading) {
      const prosList = prosHeading.nextElementSibling;
      const consList = consHeading.nextElementSibling;
      if (prosList?.tagName === "UL" && consList?.tagName === "UL") {
        const card = contentDom.window.document.createElement("div");
        card.className = "verdict-card";
        card.innerHTML = `
          <div class="verdict-col verdict-pros">
            <h4>👍 On aime</h4>
            ${prosList.outerHTML}
          </div>
          <div class="verdict-col verdict-cons">
            <h4>👎 On aime moins</h4>
            ${consList.outerHTML}
          </div>
        `;
        prosHeading.replaceWith(card);
        prosList.remove();
        consHeading.remove();
        consList.remove();
      }
    }

    // Retire les liens "lightbox" qui ne contiennent qu'une image (souvent des URLs cassées, inutiles sans JS)
    root.querySelectorAll("a").forEach(a => {
      const onlyImg = a.children.length === 1 && a.children[0].tagName === "IMG" && a.textContent.trim() === "";
      if (onlyImg) a.replaceWith(a.children[0]);
    });

    // Supprime tout élément visuellement vide, sur TOUTES les balises, en répétant jusqu'à stabilisation
    let changed = true;
    while (changed) {
      changed = false;
      root.querySelectorAll("*").forEach(el => {
        const protectedTags = ["IMG", "IFRAME", "VIDEO", "SVG"];
        if (!protectedTags.includes(el.tagName) && el.parentNode && isVisuallyEmpty(el)) {
          el.remove();
          changed = true;
        }
      });
    }

    // Supprime une image isolée en toute fin d'article (sans légende = probablement promo)
    let last = root.lastElementChild;
    while (last) {
      const onlyImage = last.children.length > 0 &&
        Array.from(last.childNodes).every(n =>
          n.nodeName === "IMG" || (n.nodeType === 3 && !n.textContent.trim())
        );
      const isBareImage = last.tagName === "IMG";
      if (onlyImage || isBareImage) {
        root.removeChild(last);
        last = root.lastElementChild;
      } else {
        break;
      }
    }

    // Si aucune image n'a survécu, on ajoute l'image de couverture (og:image) en tête
    let cleanedContent = root.innerHTML;
    if (!root.querySelector("img") && ogImage) {
      cleanedContent = `<img src="${ogImage}" alt="">` + cleanedContent;
    }

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
  table { width: 100%; border-collapse: collapse; margin: 1.5em 0; }
  th, td { padding: 0.6em 1em; border-bottom: 1px solid rgba(0,0,0,0.1); text-align: left; }
  @media (prefers-color-scheme: dark) { th, td { border-bottom-color: rgba(255,255,255,0.1); } }
  .verdict-card { display: flex; gap: 1.5em; margin: 2em 0; flex-wrap: wrap; }
  .verdict-col { flex: 1; min-width: 220px; padding: 1.2em; border-radius: 14px; background: rgba(0,0,0,0.03); }
  @media (prefers-color-scheme: dark) { .verdict-col { background: rgba(255,255,255,0.05); } }
  .verdict-col h4 { margin: 0 0 0.6em 0; font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.03em; }
  .verdict-pros h4 { color: #2e9e4f; }
  .verdict-cons h4 { color: #d64545; }
  .verdict-col ul { margin: 0; padding-left: 1.2em; }
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