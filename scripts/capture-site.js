const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const START_URL = process.argv[2] || "https://odfel.gbokopoly.edu.ng/";
const OUTPUT_DIR = path.resolve(process.argv[3] || "portal-snapshot");
const MAX_PAGES = Number(process.argv[4] || 150);

const allowedHost = new URL(START_URL).host;
const pageQueue = [START_URL];
const visitedPages = new Set();
const downloadedAssets = new Set();

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isSameHost(urlString) {
  try {
    return new URL(urlString).host === allowedHost;
  } catch {
    return false;
  }
}

function toAbsoluteUrl(base, link) {
  if (!link) return null;
  if (link.startsWith("#") || link.startsWith("mailto:") || link.startsWith("tel:") || link.startsWith("javascript:")) {
    return null;
  }
  try {
    return new URL(link, base).toString();
  } catch {
    return null;
  }
}

function outputPathFromUrl(urlString, isHtml = false) {
  const u = new URL(urlString);
  let pathname = decodeURIComponent(u.pathname);

  if (!pathname || pathname === "/") {
    pathname = "/index.html";
  }

  if (isHtml && !pathname.endsWith(".html") && !pathname.endsWith(".php")) {
    pathname = `${pathname.replace(/\/$/, "")}.html`;
  }

  const cleanPath = pathname.replace(/^\//, "");
  return path.join(OUTPUT_DIR, cleanPath);
}

function relativeLink(fromPath, toPath) {
  const fromDir = path.dirname(fromPath);
  return path.relative(fromDir, toPath).replace(/\\/g, "/");
}

async function downloadAsset(assetUrl, currentPageOutputPath) {
  if (!isSameHost(assetUrl) || downloadedAssets.has(assetUrl)) {
    return null;
  }

  downloadedAssets.add(assetUrl);

  try {
    const resp = await axios.get(assetUrl, { responseType: "arraybuffer", timeout: 20000 });
    const outPath = outputPathFromUrl(assetUrl, false);
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, resp.data);
    return relativeLink(currentPageOutputPath, outPath);
  } catch (err) {
    console.warn(`Asset download failed: ${assetUrl} (${err.message})`);
    return null;
  }
}

async function processPage(pageUrl) {
  if (visitedPages.has(pageUrl) || visitedPages.size >= MAX_PAGES) {
    return;
  }

  visitedPages.add(pageUrl);
  console.log(`Page ${visitedPages.size}/${MAX_PAGES}: ${pageUrl}`);

  let html;
  try {
    const resp = await axios.get(pageUrl, { timeout: 20000 });
    html = resp.data;
  } catch (err) {
    console.warn(`Page fetch failed: ${pageUrl} (${err.message})`);
    return;
  }

  const $ = cheerio.load(html);
  const pageOutputPath = outputPathFromUrl(pageUrl, true);
  ensureDir(path.dirname(pageOutputPath));

  const pageLinks = [];

  const assetSelectors = [
    { selector: "img", attr: "src" },
    { selector: "script", attr: "src" },
    { selector: "link", attr: "href" },
    { selector: "source", attr: "src" },
    { selector: "video", attr: "src" },
  ];

  for (const item of assetSelectors) {
    const nodes = $(item.selector).toArray();
    for (const node of nodes) {
      const raw = $(node).attr(item.attr);
      const absolute = toAbsoluteUrl(pageUrl, raw);
      if (!absolute || !isSameHost(absolute)) continue;

      const rel = await downloadAsset(absolute, pageOutputPath);
      if (rel) {
        $(node).attr(item.attr, rel);
      }
    }
  }

  $("a[href]").each((_, el) => {
    const raw = $(el).attr("href");
    const absolute = toAbsoluteUrl(pageUrl, raw);
    if (!absolute || !isSameHost(absolute)) return;

    if (!visitedPages.has(absolute) && pageQueue.length + visitedPages.size < MAX_PAGES) {
      pageQueue.push(absolute);
    }

    const targetPath = outputPathFromUrl(absolute, true);
    $(el).attr("href", relativeLink(pageOutputPath, targetPath));
    pageLinks.push(absolute);
  });

  fs.writeFileSync(pageOutputPath, $.html(), "utf8");
  console.log(`Saved ${pageOutputPath} | links: ${pageLinks.length}`);
}

async function main() {
  ensureDir(OUTPUT_DIR);
  while (pageQueue.length > 0 && visitedPages.size < MAX_PAGES) {
    const next = pageQueue.shift();
    await processPage(next);
  }

  console.log("Snapshot capture complete.");
  console.log(`Pages: ${visitedPages.size}`);
  console.log(`Assets: ${downloadedAssets.size}`);
  console.log(`Output: ${OUTPUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
