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

function looksLikeBuyBox(el) {
  const text = el.textContent.trim();
  if (text.length === 0 || text.length > 300) return false;
  const hasPrice = /\d+[\s\u00A0]?(€|\$|£)/.test(text);
  const link = el.querySelector('a[href^="http"]');
  return hasPrice && !!link;
}

function pruneTrailingContent(document, markerRegex) {
  const candidates = Array.from(document.querySelectorAll("body *"));
  const marker = candidates.find(el => markerRegex.test(el.textContent) && el.children.length < 6);
  if (!marker) return;

  let node = marker;
  while (node && node.tagName !== "BODY") {
    let sibling = node.nextSibling;
    while (sibling) {
      const toRemove = sibling;
      sibling = sibling.nextSibling;
      if (toRemove.remove) toRemove.remove();
    }
    node = node.parentElement;
  }
  marker.remove();
}

async function fetchArticleHtml(targetUrl) {
  try {
    const direct = await fetch(targetUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (direct.ok) {
      const text = await direct.text();
      if (text.length > 2000) return text;
    }
  } catch (e) { /* on retombe sur Ladder */ }

  const proxied = `${LADDER_URL}/${targetUrl}`;
  const response = await fetch(proxied, { headers: { "User-Agent": "Mozilla/5.0" } });
  return response.text();
}

app.get("/read", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Paramètre 'url' manquant");

  try {
    const html = await fetchArticleHtml(targetUrl);
    const dom = new JSDOM(html, { url: targetUrl });
    const document = dom.window.document;

    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
                     document.querySelector('meta[name="twitter:image"]')?.getAttribute("content");

    pruneTrailingContent(document, /^Sujets liés\s*:?$/i);
    pruneTrailingContent(document, /Community managers.*enquête|On filtre, on vérifie, on rédige/i);

    let buyBoxCandidates = Array.from(document.querySelectorAll("div, section, aside")).filter(looksLikeBuyBox);
    buyBoxCandidates = buyBoxCandidates.filter(el =>
      !buyBoxCandidates.some(other => other !== el && el.contains(other))
    );
    const savedBuyBoxes = buyBoxCandidates.map(el => el.outerHTML);

    document.querySelectorAll(
      '[class*="premium-promo"], [class*="card-install-pwa"], [class*="hof-box"], [class*="post-card"], [class*="related-posts"], [class*="author-bio"], [class*="post-author"], [class*="author-box"], [class*="comparators__"]'
    ).forEach(el => el.remove());

    document.querySelectorAll('[id*="embedded-tag"]').forEach(el => el.remove());

    document.querySelectorAll('img[alt*="enquête" i]').forEach(img => {
      const container = img.closest("p") || img;
      container.remove();
    });

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

    root.querySelectorAll("[style]:not(svg):not(svg *)").forEach(el => el.removeAttribute("style"));
    root.querySelectorAll("form, input, button, select, textarea").forEach(el => el.remove());
    root.querySelectorAll("video, audio, iframe").forEach(el => el.remove());

    root.querySelectorAll("ul, ol").forEach(list => {
      const links = list.querySelectorAll("a");
      const listItems = list.querySelectorAll("li");
      if (links.length > 0 && links.length >= listItems.length) {
        const allAnchors = Array.from(links).every(a => (a.getAttribute("href") || "").startsWith("#"));
        if (allAnchors) list.remove();
      }
    });

    const junkPatterns = /cookies et autres traceurs|Ce contenu est bloqué|opéré par (Twitter|Meta|Google|TikTok)|retirer votre consentement|Politique cookies|manquer aucune actualité|suivez-nous sur|écran d.accueil|en un clin d.œil|restez connectés|édito exclusif|Inscrivez-vous gratuitement|newsletter tech|ToujoursPlus|Vous avez lu.*articles|bonne raison de ne pas s.abonner|Meilleur Gestionnaire de (mots de passe|mot de passe)|Retrouvez nos tests complets/i;
    root.querySelectorAll("p, div").forEach(el => {
      const text = el.textContent.trim();
      if (junkPatterns.test(text) && !el.querySelector("img, figure, iframe, blockquote")) {
        el.remove();
      }
    });

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

    root.querySelectorAll("a").forEach(a => {
      const onlyImg = a.children.length === 1 && a.children[0].tagName === "IMG" && a.textContent.trim() === "";
      if (onlyImg) a.replaceWith(a.children[0]);
    });

    function isTextless(el) {
      return el.textContent.replace(/[\s\u00A0]/g, "").length === 0;
    }
    let last = root.lastElementChild;
    while (last && isTextless(last)) {
      root.removeChild(last);
      last = root.lastElementChild;
    }

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

    let cleanedContent = root.innerHTML;
    if (!root.querySelector("img") && ogImage) {
      cleanedContent = `<img src="${ogImage}" alt="">` + cleanedContent;
    }

    if (savedBuyBoxes.length > 0) {
      const buyBoxSection = savedBuyBoxes
        .filter(boxHtml => {
          const priceMatch = boxHtml.match(/\d+[\s\u00A0]?(€|\$|£)/);
          return priceMatch && !cleanedContent.includes(priceMatch[0]);
        })
        .map(boxHtml => `<div class="buy-box">${boxHtml}</div>`)
        .join("");
      if (buyBoxSection) {
        cleanedContent += `<div class="buy-box-section"><h4>🛒 Où l'acheter</h4>${buyBoxSection}</div>`;
      }
    }

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    max-width: 680px;
    margin: 60px auto;
    padding: 0 24px;
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 19px;
    line-height: 1.6;
    letter-spacing: -0.003em;
    font-weight: 400;
    color: #1d1d1f;
    background: #fff;
  }
  @media (prefers-color-scheme: dark) { body { color: #f5f5f7; background: #1c1c1e; } a { color: #6cb2eb; } }
  h1 {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 2.1em;
    font-weight: 700;
    line-height: 1.2;
    margin-bottom: 0.3em;
    letter-spacing: -0.02em;
    color: #000;
  }
  @media (prefers-color-scheme: dark) { h1 { color: #fff; } }
  h2, h3, h4 {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .byline { color: #86868b; font-size: 0.85em; margin-bottom: 2.5em; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 590; }
  p { margin: 1.4em 0; }
  img { max-width: 100%; height: auto; border-radius: 12px; margin: 1.5em 0; display: block; }
  figcaption { font-size: 0.8em; color: #86868b; text-align: center; margin-top: -1em; margin-bottom: 1.5em; }
  a { color: #0066cc; text-decoration: none; border-bottom: 1px solid rgba(0,102,204,0.3); }
  blockquote { margin: 2em 0; padding: 1.2em 1.4em; background: rgba(0,0,0,0.04); border-left: none; border-radius: 14px; font-style: normal; font-size: 0.95em; color: inherit; }
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
  .buy-box-section { margin: 2.5em 0; padding: 1.4em; border-radius: 14px; background: rgba(0,102,204,0.06); }
  @media (prefers-color-scheme: dark) { .buy-box-section { background: rgba(108,178,235,0.08); } }
  .buy-box-section h4 { margin: 0 0 0.8em 0; font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.03em; }
  .buy-box { margin: 0.8em 0; }
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