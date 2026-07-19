import express from "express";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const app = express();
const PORT = process.env.PORT || 3000;
const LADDER_URL = process.env.LADDER_URL || "https://ladder-bueno.theworkpc.com";

app.get("/read", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Paramètre 'url' manquant");

  try {
    const proxied = `${LADDER_URL}/${targetUrl}`;
    const response = await fetch(proxied, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await response.text();

    const dom = new JSDOM(html, { url: targetUrl });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    if (!article) return res.status(500).send("Impossible d'extraire le contenu de cet article.");

    res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${article.title}</title>
<style>
  :root {
    color-scheme: light dark;
  }
  body {
    max-width: 680px;
    margin: 60px auto;
    padding: 0 24px;
    font-family: -apple-system, "SF Pro Text", "Georgia", serif;
    font-size: 20px;
    line-height: 1.65;
    letter-spacing: 0.01em;
    color: #1a1a1a;
    background: #fff;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e8e8e8; background: #1c1c1e; }
    a { color: #6cb2eb; }
  }
  h1 {
    font-family: -apple-system, "SF Pro Display", "Georgia", serif;
    font-size: 2em;
    font-weight: 700;
    line-height: 1.25;
    margin-bottom: 0.3em;
    letter-spacing: -0.01em;
  }
  .byline {
    font-family: -apple-system, sans-serif;
    color: #86868b;
    font-size: 0.85em;
    margin-bottom: 2.5em;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  p { margin: 1.4em 0; }
  img { max-width: 100%; height: auto; border-radius: 8px; margin: 1.5em 0; }
  a { color: #0066cc; text-decoration: none; border-bottom: 1px solid rgba(0,102,204,0.3); }
  blockquote {
    border-left: 3px solid #d1d1d6;
    margin: 1.5em 0;
    padding-left: 1.2em;
    color: #515154;
    font-style: italic;
  }
  figure { margin: 1.5em 0; }
  figcaption { font-size: 0.8em; color: #86868b; text-align: center; margin-top: 0.5em; }
</style>
</head>
<body>
  <h1>${article.title}</h1>
  <div class="byline">${article.byline || ""} ${article.siteName ? "· " + article.siteName : ""}</div>
  ${article.content}
</body>
</html>`);
  } catch (err) {
    res.status(500).send("Erreur : " + err.message);
  }
});

app.listen(PORT, () => console.log(`Reader server running on port ${PORT}`));