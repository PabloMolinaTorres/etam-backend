const JSZip = require("jszip");

const ETAM_VIEWS = [
  { suffix: "x", folder: "dwecc25dfe" },
  { suffix: "a", folder: "dw9316ac3d" },
  { suffix: "b", folder: "dw3a4ad450" },
  { suffix: "c", folder: "dw406218bb" },
  { suffix: "f", folder: "dwc01a062a" },
  { suffix: "g", folder: "dwaf67e97f" },
  { suffix: "d", folder: "dwfb8de729" }
];

const DOWNLOAD_TIMEOUT_MS = 7000;

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

function getCandidateEntries(parsed) {
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

function buildZipName() {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `etam-${YYYY}${MM}${DD}-${hh}${mm}.zip`;
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
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;

    if (!rows) {
      return res.status(400).json({ error: "Debes enviar rows." });
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

      const parsed = parseEtamCode(inputCode);
      if (!parsed) {
        errors.push(`Fila ${rowNumber}: código inválido "${inputCode}".`);
        rowResults.push(rowResult);
        continue;
      }

      const entries = getCandidateEntries(parsed);
      const found = [];

      for (const entry of entries) {
        const result = await downloadImage(entry.url);

        if (!result.ok) {
          continue;
        }

        found.push({
          foundCode: entry.displayCode,
          sourceView: entry.sourceView,
          buffer: result.buffer,
          ext: result.ext
        });
      }

      if (!found.length) {
        errors.push(`Fila ${rowNumber}: no se encontraron vistas para "${inputCode}".`);
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
    const zipName = buildZipName();

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
    return res.status(200).send(zipBuffer);

  } catch (error) {
    console.error("ETAM backend error:", error);
    return res.status(500).json({
      error: "Error interno procesando ETAM."
    });
  }
};
