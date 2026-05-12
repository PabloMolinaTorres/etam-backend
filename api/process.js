const JSZip = require("jszip");

const ALLOWED_BRANDS = new Set(["etam", "brownie"]);
const DOWNLOAD_TIMEOUT_MS = 10000;

const ETAM_VIEWS = [
  { suffix: "x", folder: "dwecc25dfe" },
  { suffix: "a", folder: "dw9316ac3d" },
  { suffix: "b", folder: "dw3a4ad450" },
  { suffix: "c", folder: "dw406218bb" },
  { suffix: "f", folder: "dwc01a062a" },
  { suffix: "g", folder: "dwaf67e97f" },
  { suffix: "d", folder: "dwfb8de729" }
];

const BROWNIE_LOCALES = ["", "es-de", "es-pt", "en-be"];
const BROWNIE_MAX_FEED_PAGES = 4;

let brownieFeedCache = null;
let brownieSearchCache = new Map();

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function normalizeBrownieRef(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function brownieLocaleUrl(locale, path) {
  if (!locale) return `https://www.browniespain.com${path}`;
  return `https://www.browniespain.com/${locale}${path}`;
}

function decodeBrownieEscapedText(value) {
  return String(value || "")
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
}

function uniqPreserveOrder(arr) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function cleanBrownieImageUrl(url) {
  return decodeBrownieEscapedText(url)
    .replace(/\\+/g, "")
    .trim();
}

function extractBrownieImagesFromHtml(html) {
  const decoded = decodeBrownieEscapedText(html);
  const matches = decoded.match(/https:\/\/www\.browniespain\.com\/cdn\/shop\/files\/[^"'()\s<>\\]+/g) || [];

  return uniqPreserveOrder(
    matches
      .map(cleanBrownieImageUrl)
      .filter(url => /\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(url))
  );
}

function extractBrownieRefFromHtml(html) {
  const decoded = decodeBrownieEscapedText(html);

  const refLabelMatch = decoded.match(/Ref:\s*([A-Z0-9-]+)/i);
  if (refLabelMatch) return refLabelMatch[1].trim();

  const refJsonMatch = decoded.match(/"reference"\s*:\s*"([^"]+)"/i);
  if (refJsonMatch) return refJsonMatch[1].trim();

  return "";
}

function parseBrownieFeedEntries(pageText) {
  const entries = [];
  const decoded = decodeBrownieEscapedText(pageText);

  const entryRegex = /"reference"\s*:\s*"([^"]+)"[\s\S]*?"images"\s*:\s*\[(.*?)\][\s\S]*?"url"\s*:\s*"([^"]+)"[\s\S]*?"parent"\s*:\s*"([^"]+)"/g;
  let match;

  while ((match = entryRegex.exec(decoded)) !== null) {
    const reference = match[1];
    const imagesChunk = match[2];
    const productUrl = match[3];
    const parent = match[4];

    const imageUrls = [];
    const imageRegex = /"(https?:\/\/[^"]+)"/g;
    let imageMatch;

    while ((imageMatch = imageRegex.exec(imagesChunk)) !== null) {
      imageUrls.push(cleanBrownieImageUrl(imageMatch[1]));
    }

    const cleanImages = uniqPreserveOrder(imageUrls).filter(Boolean);

    if (!reference || !cleanImages.length) continue;

    entries.push({
      reference,
      normalizedReference: normalizeBrownieRef(reference),
      parent,
      normalizedParent: normalizeBrownieRef(parent),
      productUrl,
      images: cleanImages
    });
  }

  return entries;
}

function buildEtamUrl(model, suffix, folder) {
  return `https://images.etam.com/on/demandware.static/-/Sites-ELIN-master/default/${folder}/${model}_${suffix}.jpg?sw=1250`;
}

function parseEtamCode(code) {
  const clean = String(code || "").trim();

  const exactMatch = clean.match(/^([A-Za-z0-9]+)[_-]([a-z])$/i);
  if (exactMatch) {
    return {
      type: "exact",
      model: exactMatch[1],
      sourceView: exactMatch[2].toLowerCase()
    };
  }

  const baseMatch = clean.match(/^([A-Za-z0-9]+)$/);
  if (baseMatch) {
    return {
      type: "base",
      model: baseMatch[1],
      sourceView: null
    };
  }

  return null;
}

function getEtamCandidateEntries(parsed) {
  if (parsed.type === "exact" && parsed.sourceView) {
    const found = ETAM_VIEWS.find(v => v.suffix === parsed.sourceView);
    if (!found) return [];

    return [{
      displayCode: `${parsed.model}_${found.suffix}`,
      sourceView: found.suffix,
      url: buildEtamUrl(parsed.model, found.suffix, found.folder)
    }];
  }

  return ETAM_VIEWS.map(view => ({
    displayCode: `${parsed.model}_${view.suffix}`,
    sourceView: view.suffix,
    url: buildEtamUrl(parsed.model, view.suffix, view.folder)
  }));
}

function parseBrownieCode(code) {
  const clean = String(code || "").trim();
  const normalized = normalizeBrownieRef(clean);

  if (!clean || !normalized) return null;

  return {
    type: "base",
    raw: clean,
    normalized
  };
}

function makeBrownieHyphenVariant(raw) {
  const clean = String(raw || "").trim();
  if (!clean) return clean;

  if (/^[A-Z]\d{2}-\d{4}-\d{6}$/i.test(clean)) {
    return clean.replace(/^(.*)-(\d{3})(\d{3})$/, "$1-$2-$3");
  }

  if (/^[A-Z]\d{2}-\d{4}-\d{3}-\d{3}$/i.test(clean)) {
    return clean;
  }

  return clean;
}

function buildBrownieSearchQueries(parsed) {
  const raw = String(parsed.raw || "").trim();
  const hyphenVariant = makeBrownieHyphenVariant(raw);
  const normalized = normalizeBrownieRef(raw);

  return uniqPreserveOrder([
    raw,
    hyphenVariant,
    normalized
  ].filter(Boolean));
}

function extractBrownieProductUrlsFromSearchHtml(html) {
  const decoded = decodeBrownieEscapedText(html);
  const urls = [];

  const absoluteRegex = /https:\/\/www\.browniespain\.com\/(?:[a-z]{2}-[a-z]{2}\/)?products\/[^"'?#<\s]+/gi;
  const relativeRegex = /href="(\/(?:[a-z]{2}-[a-z]{2}\/)?products\/[^"#?<\s]+)"/gi;

  let match;

  while ((match = absoluteRegex.exec(decoded)) !== null) {
    urls.push(match[0]);
  }

  while ((match = relativeRegex.exec(decoded)) !== null) {
    urls.push(`https://www.browniespain.com${match[1]}`);
  }

  return uniqPreserveOrder(
    urls.map(url => decodeBrownieEscapedText(url).split("?")[0])
  );
}

function detectExtension(contentType = "") {
  const type = String(contentType).toLowerCase();
  if (type.includes("image/avif")) return "avif";
  if (type.includes("image/webp")) return "webp";
  if (type.includes("image/png")) return "png";
  return "jpg";
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DOWNLOAD_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

async function loadBrownieFeedEntries(forceRefresh = false) {
  if (brownieFeedCache && !forceRefresh) {
    return brownieFeedCache;
  }

  const dedupe = new Map();

  for (const locale of BROWNIE_LOCALES) {
    const baseUrl = brownieLocaleUrl(locale, "/pages/feed-empathy");

    try {
      const firstPageText = await fetchText(baseUrl, 15000);
      const pagesMatch = firstPageText.match(/"pages"\s*:\s*(\d+)/);
      const totalPages = Math.max(1, Math.min(Number(pagesMatch?.[1] || 1), BROWNIE_MAX_FEED_PAGES));

      const firstEntries = parseBrownieFeedEntries(firstPageText);
      for (const entry of firstEntries) {
        const key = `${entry.normalizedReference}|${entry.productUrl}`;
        if (!dedupe.has(key)) dedupe.set(key, entry);
      }

      for (let page = 2; page <= totalPages; page++) {
        try {
          const pageText = await fetchText(`${baseUrl}?page=${page}`, 15000);
          const pageEntries = parseBrownieFeedEntries(pageText);

          for (const entry of pageEntries) {
            const key = `${entry.normalizedReference}|${entry.productUrl}`;
            if (!dedupe.has(key)) dedupe.set(key, entry);
          }
        } catch (_) {
        }
      }
    } catch (_) {
    }
  }

  brownieFeedCache = Array.from(dedupe.values());
  return brownieFeedCache;
}

async function searchBrownieProductUrls(query) {
  const cacheKey = query.toUpperCase();
  if (brownieSearchCache.has(cacheKey)) {
    return brownieSearchCache.get(cacheKey);
  }

  const foundUrls = [];

  for (const locale of BROWNIE_LOCALES) {
    const searchUrl = brownieLocaleUrl(locale, `/search?q=${encodeURIComponent(query)}&type=product`);

    try {
      const html = await fetchText(searchUrl, 15000);
      const urls = extractBrownieProductUrlsFromSearchHtml(html);
      foundUrls.push(...urls);
    } catch (_) {
    }
  }

  const uniqueUrls = uniqPreserveOrder(foundUrls);
  brownieSearchCache.set(cacheKey, uniqueUrls);
  return uniqueUrls;
}

async function fetchBrownieProductDetail(productUrl) {
  const html = await fetchText(productUrl, 15000);
  const reference = extractBrownieRefFromHtml(html);
  const images = extractBrownieImagesFromHtml(html);

  return {
    productUrl,
    reference,
    normalizedReference: normalizeBrownieRef(reference),
    images
  };
}

async function getBrownieCandidateEntries(parsed) {
  let matched = null;

  try {
    const feedEntries = await loadBrownieFeedEntries(false);
    matched = feedEntries.find(entry =>
      entry.normalizedReference === parsed.normalized ||
      entry.normalizedParent === parsed.normalized
    );
  } catch (_) {
  }

  if (!matched) {
    const queries = buildBrownieSearchQueries(parsed);

    for (const query of queries) {
      const productUrls = await searchBrownieProductUrls(query);

      for (const productUrl of productUrls) {
        try {
          const detail = await fetchBrownieProductDetail(productUrl);
          const detailNorm = normalizeBrownieRef(detail.reference);

          if (
            detailNorm === parsed.normalized ||
            detailNorm.includes(parsed.normalized) ||
            parsed.normalized.includes(detailNorm)
          ) {
            matched = {
              reference: detail.reference || parsed.raw,
              normalizedReference: detailNorm || parsed.normalized,
              productUrl: detail.productUrl,
              images: detail.images || []
            };
            break;
          }
        } catch (_) {
        }
      }

      if (matched) break;
    }
  }

  if (!matched || !matched.images || !matched.images.length) {
    return [];
  }

  return matched.images.map((url, index) => ({
    displayCode: `${matched.reference} [${index + 1}]`,
    sourceView: String(index + 1),
    url
  }));
}

async function downloadImage(url) {
  try {
    const response = await fetchWithTimeout(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { ok: false, reason: "not_image" };
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (!buffer.length) {
      return { ok: false, reason: "empty" };
    }

    return {
      ok: true,
      buffer,
      ext: detectExtension(contentType)
    };
  } catch (error) {
    return { ok: false, reason: "timeout_or_fetch_error" };
  }
}

function buildManifestText(rowResults) {
  const okRows = rowResults.filter(r => r.ok);
  const badRows = rowResults.filter(r => !r.ok);

  const lines = [];

  lines.push("DESCARGADO CORRECTAMENTE");
  lines.push("");

  if (okRows.length) {
    okRows.forEach(row => {
      lines.push(
        `Fila ${row.rowNumber} | ${row.inputCode} | SKU ${row.skuFalabella} | ${row.downloadedFiles.join(", ")}`
      );
    });
  } else {
    lines.push("Sin registros.");
  }

  lines.push("");
  lines.push("NO DESCARGO");
  lines.push("");

  if (badRows.length) {
    badRows.forEach(row => {
      lines.push(
        `Fila ${row.rowNumber} | ${row.inputCode || "(sin código)"} | SKU ${row.skuFalabella || "(sin SKU)"}`
      );
    });
  } else {
    lines.push("Sin registros.");
  }

  return lines.join("\n");
}

function buildZipName(brand) {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${brand}-${YYYY}${MM}${DD}-${hh}${mm}.zip`;
}

module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido." });
  }

  try {
    const brand = String(req.body?.brand || "etam").toLowerCase();

    if (!ALLOWED_BRANDS.has(brand)) {
      return res.status(400).json({ error: "Marca no soportada." });
    }

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) {
      return res.status(400).json({ error: "Debes enviar rows." });
    }

    if (brand === "brownie") {
      try {
        await loadBrownieFeedEntries(false);
      } catch (_) {
      }
    }

    const zip = new JSZip();
    const rowResults = [];
    const errors = [];
    let totalFiles = 0;

    for (const row of rows) {
      const rowNumber = Number(row?.rowNumber || 0);
      const inputCode = String(row?.modelCode || "").trim();
      const skuFalabella = String(row?.skuFalabella || "").trim();

      const rowResult = {
        rowNumber,
        inputCode,
        skuFalabella,
        downloadedFiles: [],
        ok: false
      };

      if (!inputCode || !skuFalabella) {
        errors.push(`Fila ${rowNumber}: faltan datos.`);
        rowResults.push(rowResult);
        continue;
      }

      let parsed = null;
      if (brand === "etam") parsed = parseEtamCode(inputCode);
      if (brand === "brownie") parsed = parseBrownieCode(inputCode);

      if (!parsed) {
        errors.push(`Fila ${rowNumber}: código inválido "${inputCode}".`);
        rowResults.push(rowResult);
        continue;
      }

      let entries = [];
      try {
        if (brand === "etam") {
          entries = getEtamCandidateEntries(parsed);
        } else if (brand === "brownie") {
          entries = await getBrownieCandidateEntries(parsed);
        }
      } catch (_) {
        entries = [];
      }

      if (!entries.length) {
        if (brand === "brownie") {
          errors.push(`Fila ${rowNumber}: Brownie no encontró imágenes para "${inputCode}".`);
        } else {
          errors.push(`Fila ${rowNumber}: no se encontraron vistas para "${inputCode}".`);
        }
        rowResults.push(rowResult);
        continue;
      }

      const found = [];

      for (const entry of entries) {
        const result = await downloadImage(entry.url);
        if (!result.ok) continue;

        found.push({
          foundCode: entry.displayCode,
          sourceView: entry.sourceView,
          buffer: result.buffer,
          ext: result.ext
        });
      }

      if (!found.length) {
        if (brand === "brownie") {
          errors.push(`Fila ${rowNumber}: Brownie no pudo descargar imágenes para "${inputCode}".`);
        } else {
          errors.push(`Fila ${rowNumber}: no se encontraron vistas para "${inputCode}".`);
        }
        rowResults.push(rowResult);
        continue;
      }

      found.forEach((item, index) => {
        const finalView = index + 1;
        const fileName = `${skuFalabella}_${finalView}.${item.ext}`;
        zip.file(fileName, item.buffer);
        rowResult.downloadedFiles.push(fileName);
        totalFiles += 1;
      });

      rowResult.ok = rowResult.downloadedFiles.length > 0;
      rowResults.push(rowResult);
    }

    if (!totalFiles) {
      return res.status(400).json({
        error: "No se pudo descargar ninguna imagen.",
        errors,
        rowResults
      });
    }

    zip.file("manifest.txt", buildManifestText(rowResults));

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const zipName = buildZipName(brand);

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    return res.status(200).send(zipBuffer);

  } catch (error) {
    console.error("Backend error:", error);
    return res.status(500).json({
      error: "Error interno procesando la solicitud."
    });
  }
};
