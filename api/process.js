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
const BROWNIE_COLLECTION_PAGES = 4;
const BROWNIE_DETAIL_CONCURRENCY = 6;

let brownieFeedCache = null;
let brownieSearchCache = new Map();
let brownieCollectionUrlCache = null;
let brownieProductUrlCache = null;
let brownieProductDetailCache = new Map();
let brownieRefToDetailCache = new Map();

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

function pushDebugStep(debug, message) {
  if (!debug) return;
  debug.steps = debug.steps || [];
  if (debug.steps.length < 120) {
    debug.steps.push(message);
  }
}

function pushDebugDownload(debug, message) {
  if (!debug) return;
  debug.downloads = debug.downloads || [];
  if (debug.downloads.length < 40) {
    debug.downloads.push(message);
  }
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
    hyphenVariant,
    raw,
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

function extractBrownieProductUrlsFromSuggestJson(data) {
  const urls = [];
  const products = data?.resources?.results?.products;

  if (Array.isArray(products)) {
    for (const product of products) {
      const url = product?.url || product?.handle;
      if (!url) continue;

      if (String(url).startsWith("http")) {
        urls.push(String(url).split("?")[0]);
      } else if (String(url).startsWith("/")) {
        urls.push(`https://www.browniespain.com${String(url).split("?")[0]}`);
      }
    }
  }

  return uniqPreserveOrder(urls);
}

function extractBrownieCollectionUrlsFromHtml(html) {
  const decoded = decodeBrownieEscapedText(html);
  const urls = [];

  const absoluteRegex = /https:\/\/www\.browniespain\.com\/(?:[a-z]{2}-[a-z]{2}\/)?collections\/[^"'?#<\s]+/gi;
  const relativeRegex = /href="(\/(?:[a-z]{2}-[a-z]{2}\/)?collections\/[^"#?<\s]+)"/gi;

  let match;

  while ((match = absoluteRegex.exec(decoded)) !== null) {
    urls.push(match[0]);
  }

  while ((match = relativeRegex.exec(decoded)) !== null) {
    urls.push(`https://www.browniespain.com${match[1]}`);
  }

  return uniqPreserveOrder(
    urls
      .map(url => decodeBrownieEscapedText(url).split("?")[0])
      .filter(url => !/\/products\//i.test(url))
  );
}

function extractBrownieProductUrlsFromCollectionHtml(html) {
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

function normalizeBrownieProductUrl(url) {
  return String(url || "")
    .replace(/\/(es-de|es-pt|en-be|es-es|en-es|fr-fr|fr|es|en)\//i, "/")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "");
}

function prioritizeBrownieCollectionUrls(urls) {
  const preferred = [
    "https://www.browniespain.com/collections/see-all",
    "https://www.browniespain.com/collections/tshirts",
    "https://www.browniespain.com/collections/accessories",
    "https://www.browniespain.com/collections/bags",
    "https://www.browniespain.com/collections/shoes"
  ];

  const merged = uniqPreserveOrder([...preferred, ...urls]);
  return merged.map(normalizeBrownieProductUrl);
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

async function fetchJson(url, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json,text/plain,*/*"
    }
  }, timeoutMs);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.json();
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

async function loadBrownieCollectionUrls(forceRefresh = false) {
  if (brownieCollectionUrlCache && !forceRefresh) {
    return brownieCollectionUrlCache;
  }

  const found = [];

  const sitemapTargets = [
    "https://www.browniespain.com/pages/sitemap",
    "https://www.browniespain.com/es-es/pages/sitemap",
    "https://www.browniespain.com/en-es/pages/sitemap"
  ];

  for (const url of sitemapTargets) {
    try {
      const html = await fetchText(url, 15000);
      const collectionUrls = extractBrownieCollectionUrlsFromHtml(html);
      found.push(...collectionUrls);
    } catch (_) {
    }
  }

  brownieCollectionUrlCache = prioritizeBrownieCollectionUrls(found);
  return brownieCollectionUrlCache;
}

async function loadBrownieProductUrlsFromCollections(forceRefresh = false, debug = null) {
  if (brownieProductUrlCache && !forceRefresh) {
    pushDebugStep(debug, `collection-product-cache:${brownieProductUrlCache.length}`);
    return brownieProductUrlCache;
  }

  const collectionUrls = await loadBrownieCollectionUrls(forceRefresh);
  const foundProductUrls = [];
  const seenProducts = new Set();

  pushDebugStep(debug, `collection-url-count:${collectionUrls.length}`);

  for (const collectionUrl of collectionUrls) {
    let emptyPages = 0;

    for (let page = 1; page <= BROWNIE_COLLECTION_PAGES; page++) {
      const pageUrl = page === 1 ? collectionUrl : `${collectionUrl}?page=${page}`;

      try {
        const html = await fetchText(pageUrl, 15000);
        const pageProducts = extractBrownieProductUrlsFromCollectionHtml(html);

        pushDebugStep(debug, `collection-page:${pageUrl}:products=${pageProducts.length}`);

        let newCount = 0;
        for (const productUrl of pageProducts) {
          const normalizedUrl = normalizeBrownieProductUrl(productUrl);
          if (seenProducts.has(normalizedUrl)) continue;
          seenProducts.add(normalizedUrl);
          foundProductUrls.push(normalizedUrl);
          newCount += 1;
        }

        if (!pageProducts.length || newCount === 0) {
          emptyPages += 1;
        } else {
          emptyPages = 0;
        }

        if (emptyPages >= 2) {
          break;
        }
      } catch (error) {
        pushDebugStep(debug, `collection-page-error:${pageUrl}:${error.message}`);
        break;
      }
    }
  }

  brownieProductUrlCache = uniqPreserveOrder(foundProductUrls);
  pushDebugStep(debug, `collection-product-total:${brownieProductUrlCache.length}`);
  return brownieProductUrlCache;
}

async function fetchBrownieProductDetailCached(productUrl, debug = null) {
  const normalizedUrl = normalizeBrownieProductUrl(productUrl);

  if (brownieProductDetailCache.has(normalizedUrl)) {
    pushDebugStep(debug, `pdp-cache-hit:${normalizedUrl}`);
    return brownieProductDetailCache.get(normalizedUrl);
  }

  const detail = await fetchBrownieProductDetail(normalizedUrl, debug);
  brownieProductDetailCache.set(normalizedUrl, detail);

  if (detail?.normalizedReference) {
    brownieRefToDetailCache.set(detail.normalizedReference, detail);
  }

  return detail;
}

async function findBrownieProductViaCollections(parsed, debug) {
  const hyphenVariant = makeBrownieHyphenVariant(parsed.raw);
  const hyphenNorm = normalizeBrownieRef(hyphenVariant);

  if (brownieRefToDetailCache.has(parsed.normalized)) {
    pushDebugStep(debug, `ref-cache-hit:${parsed.normalized}`);
    return brownieRefToDetailCache.get(parsed.normalized);
  }

  if (brownieRefToDetailCache.has(hyphenNorm)) {
    pushDebugStep(debug, `ref-cache-hit:${hyphenNorm}`);
    return brownieRefToDetailCache.get(hyphenNorm);
  }

  const productUrls = await loadBrownieProductUrlsFromCollections(false, debug);

  for (let i = 0; i < productUrls.length; i += BROWNIE_DETAIL_CONCURRENCY) {
    const chunk = productUrls.slice(i, i + BROWNIE_DETAIL_CONCURRENCY);

    const details = await Promise.all(
      chunk.map(async (url) => {
        try {
          return await fetchBrownieProductDetailCached(url, debug);
        } catch (error) {
          pushDebugStep(debug, `collection-pdp-error:${url}:${error.message}`);
          return null;
        }
      })
    );

    for (const detail of details) {
      if (!detail) continue;

      const detailNorm = normalizeBrownieRef(detail.reference);

      if (
        detailNorm === parsed.normalized ||
        detailNorm === hyphenNorm ||
        detailNorm.includes(parsed.normalized) ||
        parsed.normalized.includes(detailNorm)
      ) {
        pushDebugStep(debug, `collection-pdp-match:${detail.reference || "no-ref"}:images=${detail.images?.length || 0}`);
        return detail;
      }
    }

    pushDebugStep(debug, `collection-scan-progress:${Math.min(i + BROWNIE_DETAIL_CONCURRENCY, productUrls.length)}/${productUrls.length}`);
  }

  return null;
}

async function searchBrownieProductUrls(query, debug) {
  const cacheKey = query.toUpperCase();
  if (brownieSearchCache.has(cacheKey)) {
    pushDebugStep(debug, `search-cache-hit:${query}`);
    return brownieSearchCache.get(cacheKey);
  }

  const foundUrls = [];

  for (const locale of BROWNIE_LOCALES) {
    const suggestUrl = brownieLocaleUrl(
      locale,
      `/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10`
    );

    try {
      const data = await fetchJson(suggestUrl, 15000);
      const suggestUrls = extractBrownieProductUrlsFromSuggestJson(data);
      foundUrls.push(...suggestUrls);
      pushDebugStep(debug, `suggest:${locale || "root"}:${query}:${suggestUrls.length}`);
    } catch (error) {
      pushDebugStep(debug, `suggest-error:${locale || "root"}:${query}:${error.message}`);
    }

    const searchUrl = brownieLocaleUrl(locale, `/search?q=${encodeURIComponent(query)}&type=product`);

    try {
      const html = await fetchText(searchUrl, 15000);
      const urls = extractBrownieProductUrlsFromSearchHtml(html);
      foundUrls.push(...urls);
      pushDebugStep(debug, `search-html:${locale || "root"}:${query}:${urls.length}`);
    } catch (error) {
      pushDebugStep(debug, `search-html-error:${locale || "root"}:${query}:${error.message}`);
    }
  }

  const uniqueUrls = uniqPreserveOrder(foundUrls);
  brownieSearchCache.set(cacheKey, uniqueUrls);

  if (debug) {
    pushDebugStep(debug, `search-total:${query}:${uniqueUrls.length}`);
    if (uniqueUrls.length) {
      debug.sampleUrls = uniqueUrls.slice(0, 5);
    }
  }

  return uniqueUrls;
}

async function fetchBrownieProductDetail(productUrl, debug) {
  const html = await fetchText(productUrl, 15000);
  const reference = extractBrownieRefFromHtml(html);
  const images = extractBrownieImagesFromHtml(html);

  if (debug) {
    pushDebugStep(debug, `pdp:${productUrl}:ref=${reference || "none"}:images=${images.length}`);
  }

  return {
    productUrl,
    reference,
    normalizedReference: normalizeBrownieRef(reference),
    images
  };
}

function buildBrownieDebugMessage(parsed, debug, phase) {
  const hyphenVariant = makeBrownieHyphenVariant(parsed.raw);
  const parts = [
    `Brownie debug`,
    `fase=${phase}`,
    `raw=${parsed.raw}`,
    `normalized=${parsed.normalized}`,
    `hyphen=${hyphenVariant}`,
    `feedCount=${debug.feedCount}`,
    `feedMatch=${debug.feedMatch || "none"}`,
    `queries=${debug.queries.join(" | ") || "none"}`,
    `sampleUrls=${(debug.sampleUrls || []).join(" | ") || "none"}`,
    `downloads=${(debug.downloads || []).join(" | ") || "none"}`,
    `steps=${debug.steps.join(" || ") || "none"}`
  ];
  return parts.join(" | ");
}

async function getBrownieCandidateEntries(parsed, debug) {
  let matched = null;
  const hyphenVariant = makeBrownieHyphenVariant(parsed.raw);
  const hyphenNorm = normalizeBrownieRef(hyphenVariant);

  debug.feedCount = 0;
  debug.feedMatch = "";
  debug.steps = debug.steps || [];
  debug.queries = debug.queries || [];
  debug.sampleUrls = debug.sampleUrls || [];

  if (brownieRefToDetailCache.has(parsed.normalized)) {
    matched = brownieRefToDetailCache.get(parsed.normalized);
    pushDebugStep(debug, `ref-cache-direct:${parsed.normalized}`);
  } else if (brownieRefToDetailCache.has(hyphenNorm)) {
    matched = brownieRefToDetailCache.get(hyphenNorm);
    pushDebugStep(debug, `ref-cache-direct:${hyphenNorm}`);
  }

  if (!matched) {
    try {
      const feedEntries = await loadBrownieFeedEntries(false);
      debug.feedCount = feedEntries.length;

      matched = feedEntries.find(entry =>
        entry.normalizedReference === parsed.normalized ||
        entry.normalizedParent === parsed.normalized ||
        entry.normalizedReference === hyphenNorm ||
        entry.normalizedParent === hyphenNorm
      );

      if (matched) {
        debug.feedMatch = matched.reference || matched.productUrl || "matched";
        pushDebugStep(debug, `feed-match:${matched.reference || "no-ref"}:images=${matched.images?.length || 0}`);
      } else {
        pushDebugStep(debug, `feed-no-match:${parsed.raw}`);
      }
    } catch (error) {
      pushDebugStep(debug, `feed-error:${error.message}`);
    }
  }

  if (!matched) {
    const queries = buildBrownieSearchQueries(parsed);
    debug.queries = queries;

    for (const query of queries) {
      const productUrls = await searchBrownieProductUrls(query, debug);

      for (const productUrl of productUrls) {
        try {
          const detail = await fetchBrownieProductDetailCached(productUrl, debug);
          const detailNorm = normalizeBrownieRef(detail.reference);

          if (
            detailNorm === parsed.normalized ||
            detailNorm === hyphenNorm ||
            detailNorm.includes(parsed.normalized) ||
            parsed.normalized.includes(detailNorm)
          ) {
            matched = {
              reference: detail.reference || parsed.raw,
              normalizedReference: detailNorm || parsed.normalized,
              productUrl: detail.productUrl,
              images: detail.images || []
            };
            pushDebugStep(debug, `pdp-match:${detail.reference || "no-ref"}:images=${detail.images?.length || 0}`);
            break;
          } else {
            pushDebugStep(debug, `pdp-no-match:${detail.reference || "no-ref"}`);
          }
        } catch (error) {
          pushDebugStep(debug, `pdp-error:${productUrl}:${error.message}`);
        }
      }

      if (matched) break;
    }
  }

  if (!matched) {
    const collectionDetail = await findBrownieProductViaCollections(parsed, debug);
    if (collectionDetail) {
      const detailNorm = normalizeBrownieRef(collectionDetail.reference);
      matched = {
        reference: collectionDetail.reference || parsed.raw,
        normalizedReference: detailNorm || parsed.normalized,
        productUrl: collectionDetail.productUrl,
        images: collectionDetail.images || []
      };
    } else {
      pushDebugStep(debug, `collection-no-match:${parsed.raw}`);
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
  } catch (_) {
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
      const brownieDebug = {
        rowNumber,
        inputCode,
        steps: [],
        queries: [],
        sampleUrls: [],
        downloads: [],
        feedCount: 0,
        feedMatch: ""
      };

      try {
        if (brand === "etam") {
          entries = getEtamCandidateEntries(parsed);
        } else if (brand === "brownie") {
          entries = await getBrownieCandidateEntries(parsed, brownieDebug);
        }
      } catch (error) {
        if (brand === "brownie") {
          pushDebugStep(brownieDebug, `entries-error:${error.message}`);
        }
        entries = [];
      }

      if (!entries.length) {
        if (brand === "brownie") {
          const debugMsg = buildBrownieDebugMessage(parsed, brownieDebug, "discovery");
          console.log(`[BROWNIE][ROW ${rowNumber}] ${debugMsg}`);
          errors.push(`Fila ${rowNumber}: ${debugMsg}`);
        } else {
          errors.push(`Fila ${rowNumber}: no se encontraron vistas para "${inputCode}".`);
        }
        rowResults.push(rowResult);
        continue;
      }

      const found = [];

      for (const entry of entries) {
        const result = await downloadImage(entry.url);

        if (brand === "brownie") {
          pushDebugDownload(brownieDebug, `${entry.url}=>${result.ok ? "ok" : result.reason}`);
        }

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
          const debugMsg = buildBrownieDebugMessage(parsed, brownieDebug, "download");
          console.log(`[BROWNIE][ROW ${rowNumber}] ${debugMsg}`);
          errors.push(`Fila ${rowNumber}: ${debugMsg}`);
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
