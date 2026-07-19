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

app.get("/read", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Paramètre 'url' manquant");

  try {
    const proxied = `${LADDER_URL}/${targetUrl}`;
    const response = await fetch(proxied, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await response.text();

    const dom = new JSDOM(html, { url: targetUrl });
    const document = dom.window.document;

    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
                     document.querySelector('meta[name="twitter:image"]')?.getAttribute("content");

    // Repère les encarts "acheter" (prix + lien marchand) AVANT que Readability ne les efface
    let buyBoxCandidates = Array.from(document.querySelectorAll("div, section, aside")).filter(looksLikeBuyBox);
    buyBoxCandidates = buyBoxCandidates.filter(el =>
      !buyBoxCandidates.some(other => other !== el && el.contains(other))
    );
    const savedBuyBoxes = buyBoxCandidates.map(el => el.outerHTML);

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

    root.querySelectorAll("ul, ol").forEach(list => {
      const links = list.querySelectorAll("a");
      const listItems = list.querySelectorAll("li");
      if (links.length > 0 && links.length >= listItems.length) {
        const allAnchors = Array.from(links).every(a => (a.getAttribute("href") || "").startsWith("#"));
        if (allAnchors) list.remove();
      }
    });

    const junkPatterns = /cookies et autres traceurs|Ce contenu est bloqué|opéré par (Twitter|Meta|Google|TikTok)|retirer votre consentement|Politique cookies|manquer aucune actualité|suivez-nous sur|écran d.accueil|en un clin d.œil|restez connectés|édito exclusif|Inscrivez-vous gratuitement|newsletter tech|ToujoursPlus/i;
    root.querySelectorAll("p, div").forEach(el => {
      const text = el.textContent.trim();
      if (junkPatterns.test(text) && !el.querySelector("img, figure, iframe, blockquote")) {
        el.remove();
      }
    });

    const prosPattern =