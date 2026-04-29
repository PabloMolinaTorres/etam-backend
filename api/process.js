import JSZip from "jszip";

const ETAM_VIEWS = [
  { suffix: "x", folder: "dwecc25dfe" },
  { suffix: "a", folder: "dw9316ac3d" },
  { suffix: "b", folder: "dw3a4ad450" },
  { suffix: "c", folder: "dw406218bb" },
  { suffix: "f", folder: "dwc01a062a" },
  { suffix: "g", folder: "dwaf67e97f" },
  { suffix: "d", folder: "dwfb8de729" }
];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
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

async function downloadImage(url) {
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      return { ok: false };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("image/")) {
      return { ok: false };
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (!bytes.length) {
      return { ok: false };
    }

    return {
      ok: true,
      bytes,
      mimeType: contentType,
      ext: detectExtension(contentType)
    };
  } catch {
    return { ok: false };
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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders()
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Método no permitido." }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "JSON inválido." }, 400);
    }

    const rows = Array.isArray(body?.rows) ? body.rows : null;
    if (!rows) {
      return jsonResponse({ error: "Debes enviar rows." }, 400);
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
        if (!result.ok) continue;

        found.push({
          foundCode: entry.displayCode,
          sourceView: entry.sourceView,
          bytes: result.bytes,
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
        zip.file(fileName, item.bytes);
        rowResult.downloadedFiles.push(fileName);
        totalFiles += 1;
      });

      rowResult.ok = rowResult.downloadedFiles.length > 0;
      rowResults.push(rowResult);
    }

    if (!totalFiles) {
      return jsonResponse({
        error: "No se pudo descargar ninguna imagen.",
        errors,
        rowResults
      }, 400);
    }

    zip.file("manifest.txt", buildManifestText(rowResults));

    const zipBytes = await zip.generateAsync({ type: "uint8array" });
    const zipName = buildZipName();

    return new Response(zipBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        ...corsHeaders()
      }
    });
  }
};
