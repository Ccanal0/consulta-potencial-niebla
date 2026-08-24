/**
 * Explorador Espacial NetCDF AMARU
 * Motor Universal WebAssembly HDF5 / NetCDF4 y NetCDF3 (Frontend en Español)
 */

// Registrar Proyecciones Proj4
proj4.defs("EPSG:32719", "+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:32718", "+proj=utm +zone=18 +south +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

// Estado de la Aplicación
const state = {
  selectedCrs: "EPSG:32719",
  easting: 350000,
  northing: 6300000,
  lat: -33.4372,
  lon: -70.6506,
  catalog: [],
  regionalIndex: null,
  activeFilename: null,
  ncData: null,
  extractedTimeSeries: null,
  ncCache: new Map(),
  h5wasmReady: false
};

// Elementos del DOM
const crsSelect = document.getElementById("crs-select");
const datasetSelect = document.getElementById("dataset-select");
const eastingInput = document.getElementById("easting-input");
const northingInput = document.getElementById("northing-input");
const btnExtract = document.getElementById("btn-extract");
const btnExportExcel = document.getElementById("btn-export-excel");
const loadedFileInfo = document.getElementById("loaded-file-info");
const fileNameDisplay = document.getElementById("file-name-display");
const varSelect = document.getElementById("var-select");
const statusText = document.getElementById("status-text");

const metaFileName = document.getElementById("meta-file-name");
const metaLatLon = document.getElementById("meta-latlon");
const metaGrid = document.getElementById("meta-grid");
const metaNearestCoords = document.getElementById("meta-nearest-coords");
const metaTimeCount = document.getElementById("meta-time-count");

// Mapa Leaflet y Capas
let map, marker, regionPolygonsGroup;
let ncOverlayLayer = null;
let ncLegendControl = null;

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  setupEventListeners();
  await initH5Wasm();          // esperar antes de cargar archivos
  await loadCatalogAndIndex();
});

/**
 * Esperar a que el Motor WebAssembly HDF5 (h5wasm) se descargue del CDN e inicialice.
 */
async function waitForH5Wasm(timeoutMs = 12000) {
  if (state.h5wasmReady && typeof h5wasm !== "undefined" && h5wasm.FS) return true;

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (typeof h5wasm !== "undefined" && h5wasm.ready) {
      try {
        await h5wasm.ready;
        state.h5wasmReady = true;
        console.log("Motor WebAssembly HDF5 (h5wasm) listo. FS disponible:", !!h5wasm.FS);
        return true;
      } catch (e) {
        console.warn("Error al inicializar h5wasm:", e);
        return false;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  console.warn("Timeout esperando disponibilidad de h5wasm");
  return false;
}

/**
 * Inicializar Motor WebAssembly HDF5 (h5wasm)
 */
async function initH5Wasm() {
  statusText.textContent = "Cargando motor WASM...";
  const ready = await waitForH5Wasm(12000);
  if (ready) {
    statusText.textContent = "Motor WebAssembly Listo";
    // Si un dataset se cargó en modo indexado antes de que el motor estuviese listo, re-cargarlo ahora
    if (state.ncData && state.ncData.isIndexedFallback && state.activeFilename) {
      console.log("Motor WASM listo. Re-cargando dataset activo:", state.activeFilename);
      fetchAndLoadNetCDF(state.activeFilename);
    }
  } else {
    statusText.textContent = "Catálogo Listo (Modo Respaldo)";
  }
}

function initMap() {
  map = L.map("map", { center: [-30.0, -71.0], zoom: 6 });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; Colaboradores de OpenStreetMap &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 19
  }).addTo(map);

  regionPolygonsGroup = L.layerGroup().addTo(map);

  const customIcon = L.divIcon({
    className: "custom-map-marker",
    html: `<div style="background:#38bdf8; width:16px; height:16px; border-radius:50%; border:3px solid #ffffff; box-shadow:0 0 12px #38bdf8;"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  marker = L.marker([-33.4372, -70.6506], { draggable: true, icon: customIcon }).addTo(map);

  marker.on("dragend", (e) => {
    const latLng = e.target.getLatLng();
    updateCoordsFromLatLon(latLng.lat, latLng.lng);
  });

  map.on("click", (e) => {
    const latLng = e.latlng;
    marker.setLatLng(latLng);
    updateCoordsFromLatLon(latLng.lat, latLng.lng);
  });
}

function setupEventListeners() {
  crsSelect.addEventListener("change", (e) => {
    state.selectedCrs = e.target.value;
    const xUnit = document.getElementById("x-unit");
    const yUnit = document.getElementById("y-unit");

    if (state.selectedCrs === "EPSG:4326") {
      xUnit.textContent = "grados Lon";
      yUnit.textContent = "grados Lat";
    } else {
      xUnit.textContent = "metros";
      yUnit.textContent = "metros";
    }
    updateCoordsFromLatLon(state.lat, state.lon);
  });

  eastingInput.addEventListener("input", updateCoordsFromInputs);
  northingInput.addEventListener("input", updateCoordsFromInputs);

  datasetSelect.addEventListener("change", () => {
    const selected = datasetSelect.value;
    if (selected !== "AUTO") {
      fetchAndLoadNetCDF(selected);
    } else {
      autoDetectAndLoadRegion();
    }
  });

  btnExtract.addEventListener("click", () => {
    queryAndPlot();
  });

  btnExportExcel.addEventListener("click", () => {
    exportToExcel();
  });

  varSelect.addEventListener("change", () => { renderPlot(); drawNetCDFOverlay(); });
}

async function loadCatalogAndIndex() {
  try {
    statusText.textContent = "Cargando Índice Regional...";
    
    // Obtener catálogo
    const resCat = await fetch("data/catalog.json");
    if (resCat.ok) state.catalog = await resCat.json();

    // Obtener índice espacial
    const resIdx = await fetch("data/regional_index.json");
    if (resIdx.ok) state.regionalIndex = await resIdx.json();

    statusText.textContent = `Catálogo Listo (${state.catalog.length} archivos)`;

    populateDatasetDropdown();
    drawCatalogPolygonsOnMap();
    autoDetectAndLoadRegion();
  } catch (err) {
    console.warn("No se pudo cargar el índice regional:", err);
    statusText.textContent = "Modo de Carga Listo";
  }
}

function populateDatasetDropdown() {
  datasetSelect.innerHTML = `<option value="AUTO">⚡ Detección Automática de Región según Coordenadas</option>`;
  state.catalog.forEach((item) => {
    const opt = document.createElement("option");
    opt.value = item.filename;
    opt.textContent = `${item.filename} (${item.size_mb} MB)`;
    datasetSelect.appendChild(opt);
  });
}

function drawCatalogPolygonsOnMap() {
  regionPolygonsGroup.clearLayers();

  state.catalog.forEach((item) => {
    const bounds = [[item.min_lat, item.min_lon], [item.max_lat, item.max_lon]];

    const poly = L.rectangle(bounds, {
      color: "#38bdf8", weight: 1, fillColor: "#38bdf8", fillOpacity: 0.08
    }).addTo(regionPolygonsGroup);

    poly.bindTooltip(item.filename.replace('_compressed.nc', ''), { permanent: false, direction: "center" });

    poly.on("click", () => {
      datasetSelect.value = item.filename;
      fetchAndLoadNetCDF(item.filename);
    });
  });
}

function autoDetectAndLoadRegion() {
  if (datasetSelect.value !== "AUTO") return;
  if (!state.catalog.length) return;

  const lat = state.lat;
  const lon = state.lon;

  const match = state.catalog.find(
    (item) => lat >= item.min_lat && lat <= item.max_lat && lon >= item.min_lon && lon <= item.max_lon
  );

  if (match) {
    fetchAndLoadNetCDF(match.filename);
  } else {
    const defaultFile = state.catalog.find(c => c.filename.includes('Valparaiso')) || state.catalog[0];
    fetchAndLoadNetCDF(defaultFile.filename);
  }
}

/**
 * Carga de NetCDF a través de HTTP y Parser Universal
 */
async function fetchAndLoadNetCDF(filename) {
  if (state.activeFilename === filename && state.ncData && !state.ncData.isIndexedFallback) {
    queryAndPlot();
    return;
  }

  statusText.textContent = `Cargando ${filename}...`;

  // Esperar a que el motor WASM se inicialice si la red está lenta (ej: GitHub Pages)
  await waitForH5Wasm(12000);

  try {
    let buffer;
    if (state.ncCache.has(filename)) {
      buffer = state.ncCache.get(filename);
    } else {
      const res = await fetch(`data/${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buffer = await res.arrayBuffer();
      state.ncCache.set(filename, buffer);
    }

    const parsed = await parseUniversalNetCDF(buffer, filename);
    state.activeFilename = filename;
    state.ncData = parsed;

    fileNameDisplay.textContent = filename;
    loadedFileInfo.style.display = "block";
    statusText.textContent = `Cargado ${filename}`;

    populateVariableSelect();
    queryAndPlot();
    drawNetCDFOverlay();
  } catch (err) {
    console.error("Fallo al procesar NetCDF:", err);
    
    // Respaldo mediante índice espacial regional
    if (state.regionalIndex && state.regionalIndex[filename]) {
      console.log("Usando respaldo indexado para:", filename);
      const idxEntry = state.regionalIndex[filename];
      state.activeFilename = filename;
      state.ncData = {
        dimensions: { y: idxEntry.y.length, x: idxEntry.x.length, time: idxEntry.time.length },
        variables: idxEntry.variables,
        x: idxEntry.x,
        y: idxEntry.y,
        time: idxEntry.time,
        isIndexedFallback: true
      };

      fileNameDisplay.textContent = `${filename} (Indexado)`;
      loadedFileInfo.style.display = "block";
      statusText.textContent = `Cargado ${filename} (Indexado)`;

      populateVariableSelect();
      queryAndPlot();
      drawNetCDFOverlay();
    } else {
      statusText.textContent = `Error al cargar ${filename}`;
      alert(`No se pudo cargar ${filename}. Asegúrate de que el navegador soporte ArrayBuffer.`);
    }
  }
}

/**
 * Parser Universal de NetCDF (h5wasm para NetCDF4 o netcdfjs para NetCDF3)
 */
async function parseUniversalNetCDF(arrayBuffer, filename = "archivo.nc") {
  // Método 1: h5wasm para NetCDF4 / HDF5
  if (typeof h5wasm !== "undefined" && h5wasm.FS) {
    try {
      // En el build IIFE, h5wasm.FS es un getter directo disponible tras await h5wasm.ready
      const FS = h5wasm.FS;
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      FS.writeFile(safeName, new Uint8Array(arrayBuffer));

      const file = new h5wasm.File(safeName, "r");
      const vars = {};
      let xArr = null, yArr = null, timeArr = null;

      function readAttrs(item) {
        const attrs = {};
        try {
          if (item && item.attrs) {
            for (const aKey of item.attrs.keys()) {
              try {
                let attrObj = item.attrs.get(aKey);
                let val = attrObj ? attrObj.value : null;
                if (val instanceof Uint8Array || val instanceof Int8Array || val instanceof Uint8ClampedArray) {
                  val = new TextDecoder().decode(val).replace(/\0/g, "").trim();
                } else if (Array.isArray(val)) {
                  val = val.map(v => (v instanceof Uint8Array) ? new TextDecoder().decode(v) : (typeof v === "number" ? String.fromCharCode(v) : String(v))).join("").replace(/\0/g, "").trim();
                } else if (typeof val === "string") {
                  val = val.replace(/\0/g, "").trim();
                }
                attrs[aKey] = val;
              } catch (_) {}
            }
          }
        } catch (_) {}
        return attrs;
      }

      // CRITICAL: item.value is backed by WASM heap memory.
      // After file.close() that memory is freed — all values read as 0.
      // copyToJS() creates an independent JS-heap copy BEFORE file.close().
      function copyToJS(raw) {
        if (!raw) return null;
        if (raw instanceof BigInt64Array || raw instanceof BigUint64Array)
          return Array.from(raw, v => Number(v));
        if (raw instanceof Float32Array) return new Float32Array(raw);
        if (raw instanceof Float64Array) return new Float64Array(raw);
        if (raw instanceof Int32Array)   return new Int32Array(raw);
        if (raw instanceof Int16Array)   return new Int16Array(raw);
        if (ArrayBuffer.isView(raw))     return new Float32Array(raw);
        if (Array.isArray(raw)) {
          try { return new Float32Array(raw.flat ? raw.flat(Infinity) : [].concat(...raw)); }
          catch (_) { return raw; }
        }
        return raw;
      }

      function formatTimeArray(data, attrs, filename) {
        if (!data || !data.length) return null;

        // Try parsing 'days since YYYY-MM-DD' from units or calendar attributes
        const unitsStr = String(attrs.units || attrs.calendar_type || "").toLowerCase();
        let formatted = null;

        if (unitsStr.includes("days since")) {
          const dateMatch = unitsStr.match(/days since\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/i) || unitsStr.match(/days since\s*([0-9]{4})/i);
          if (dateMatch) {
            const baseStr = dateMatch[1].length === 4 ? `${dateMatch[1]}-01-01` : dateMatch[1];
            const baseTime = new Date(`${baseStr}T00:00:00Z`).getTime();
            if (!isNaN(baseTime)) {
              formatted = Array.from(data, d => {
                const dateObj = new Date(baseTime + Number(d) * 86400000);
                return dateObj.toISOString().slice(0, 10);
              });
            }
          }
        }

        // Fallback 1: Use sample_times from catalog if available and length matches
        if (!formatted && state.catalog) {
          const catItem = state.catalog.find(c => c.filename === filename);
          if (catItem && catItem.sample_times && catItem.sample_times.length === data.length) {
            formatted = [...catItem.sample_times];
          }
        }

        // Fallback 2: Extract year from filename (e.g. 2023, 2018...)
        if (!formatted) {
          let baseYear = 2023;
          const yrMatch = filename.match(/\b(20\d\d)\b/);
          if (yrMatch) baseYear = parseInt(yrMatch[1]);

          const baseTime = new Date(`${baseYear}-01-01T00:00:00Z`).getTime();
          formatted = Array.from(data, d => {
            const numD = Number(d);
            if (!isNaN(numD)) {
              return new Date(baseTime + numD * 86400000).toISOString().slice(0, 10);
            }
            return String(d);
          });
        }

        return formatted;
      }

      function inspectGroup(group) {
        for (const key of group.keys()) {
          let item;
          try { item = group.get(key); } catch (_) { continue; }
          if (item instanceof h5wasm.Dataset) {
            let rawData;
            try { rawData = item.value; } catch (_) { rawData = null; }
            const data = copyToJS(rawData);   // copy before file.close()!
            const attrs = readAttrs(item);
            const shapeStr = (item.shape || []).join("x");
            vars[key] = { name: key, dimensions: item.shape, data: data, units: attrs.units || "", attributes: attrs };
            console.log("h5wasm " + key + " [" + shapeStr + "] len=" + (data ? data.length : "null") + " units=" + (attrs.units || ""));

            const kLower = key.toLowerCase();
            if (["x", "lon", "longitude", "easting"].includes(kLower) && data) xArr = Array.from(data);
            if (["y", "lat", "latitude", "northing"].includes(kLower) && data) yArr = Array.from(data);
            if (["time", "datetime", "date"].includes(kLower) && data) {
              timeArr = formatTimeArray(data, attrs, filename);
              console.log("h5wasm parsed time dates:", timeArr);
            }
          } else if (item instanceof h5wasm.Group) {
            inspectGroup(item);
          }
        }
      }

      inspectGroup(file);
      file.close();

      console.log("h5wasm parsed " + filename + ": x=" + (xArr ? xArr.length : "null") + ", y=" + (yArr ? yArr.length : "null") + ", vars=" + Object.keys(vars).join(","));

      if (xArr && yArr) {
        return { dimensions: {}, variables: vars, x: xArr, y: yArr, time: timeArr };
      }
      throw new Error("No se encontraron coords x/y en " + filename + ". Variables halladas: " + Object.keys(vars).join(", "));
    } catch (e) {
      console.warn("h5wasm error, intentando netcdfjs:", e.message || e);
    }
  }

  // Método 2: netcdfjs para NetCDF3 Clásico
  if (typeof netcdfjs !== "undefined") {
    const ncReader = new netcdfjs(arrayBuffer);
    const vars = {};
    const dims = {};

    ncReader.dimensions.forEach((d) => { dims[d.name] = d.size; });

    let xArr = null, yArr = null, timeArr = null;

    ncReader.variables.forEach((v) => {
      const data = ncReader.getDataVariable(v.name);
      vars[v.name] = {
        name: v.name,
        dimensions: v.dimensions,
        data: data,
        attributes: v.attributes
      };

      const nameLower = v.name.toLowerCase();
      if (["x", "lon", "longitude", "easting"].includes(nameLower)) xArr = Array.from(data);
      if (["y", "lat", "latitude", "northing"].includes(nameLower)) yArr = Array.from(data);
      if (["time", "datetime", "date"].includes(nameLower)) timeArr = Array.from(data);
    });

    return { dimensions: dims, variables: vars, x: xArr, y: yArr, time: timeArr };
  }

  throw new Error("No hay parser de NetCDF disponible");
}

function updateCoordsFromLatLon(lat, lon) {
  state.lat = lat;
  state.lon = lon;

  if (state.selectedCrs === "EPSG:4326") {
    state.easting = parseFloat(lon.toFixed(6));
    state.northing = parseFloat(lat.toFixed(6));
  } else {
    try {
      const proj = proj4("EPSG:4326", state.selectedCrs, [lon, lat]);
      state.easting = Math.round(proj[0]);
      state.northing = Math.round(proj[1]);
    } catch (e) {}
  }

  eastingInput.value = state.easting;
  northingInput.value = state.northing;

  if (datasetSelect.value === "AUTO") {
    autoDetectAndLoadRegion();
  } else {
    queryAndPlot();
  }
}

function updateCoordsFromInputs() {
  const x = parseFloat(eastingInput.value);
  const y = parseFloat(northingInput.value);

  if (isNaN(x) || isNaN(y)) return;

  state.easting = x;
  state.northing = y;

  if (state.selectedCrs === "EPSG:4326") {
    state.lat = y;
    state.lon = x;
  } else {
    try {
      const geo = proj4(state.selectedCrs, "EPSG:4326", [x, y]);
      state.lon = geo[0];
      state.lat = geo[1];
    } catch (e) {}
  }

  const latLng = L.latLng(state.lat, state.lon);
  marker.setLatLng(latLng);
  map.panTo(latLng);

  if (datasetSelect.value === "AUTO") {
    autoDetectAndLoadRegion();
  } else {
    queryAndPlot();
  }
}

function populateVariableSelect() {
  varSelect.innerHTML = `<option value="all">Todas las Variables</option>`;
  if (!state.ncData) return;

  Object.keys(state.ncData.variables).forEach((varName) => {
    if (!["x", "y", "lat", "lon", "time", "datetime"].includes(varName.toLowerCase())) {
      const opt = document.createElement("option");
      opt.value = varName;
      opt.textContent = varName;
      varSelect.appendChild(opt);
    }
  });
}

function queryAndPlot() {
  if (!state.ncData) return;

  const targetX = state.easting;
  const targetY = state.northing;
  const xArr = state.ncData.x;
  const yArr = state.ncData.y;

  if (!xArr || !yArr) return;

  let nearestI = 0, nearestJ = 0;

  // Usar loop en vez de spread para evitar stack overflow en arrays grandes
  let xMin = xArr[0], xMax = xArr[0];
  for (let k = 1; k < xArr.length; k++) { if (xArr[k] < xMin) xMin = xArr[k]; if (xArr[k] > xMax) xMax = xArr[k]; }
  const isNcLatLon = xMax <= 180 && xMin >= -180;
  const queryX = isNcLatLon ? state.lon : targetX;
  const queryY = isNcLatLon ? state.lat : targetY;

  // Lightweight debug: shows clicked coords and found grid indices
  console.log("query: lat="+queryY.toFixed(4)+" lon="+queryX.toFixed(4)+" → nearestJ=" + 0 + " nearestI=" + 0 + " (computing...)");

  for (let i = 0; i < xArr.length; i++) {
    if (Math.abs(xArr[i] - queryX) < Math.abs(xArr[nearestI] - queryX)) nearestI = i;
  }

  for (let j = 0; j < yArr.length; j++) {
    if (Math.abs(yArr[j] - queryY) < Math.abs(yArr[nearestJ] - queryY)) nearestJ = j;
  }

  const numY = yArr.length;
  const numX = xArr.length;

  let timeSteps = state.ncData.time;

  // Guarantee dates are formatted ISO strings (e.g. 2023-01-01) instead of raw day offsets (0..365)
  if (!timeSteps || timeSteps.length === 0 || timeSteps.every(t => !isNaN(Number(t)))) {
    const catItem = state.catalog.find(c => c.filename === state.activeFilename);
    if (catItem && catItem.sample_times && catItem.sample_times.length > 0) {
      timeSteps = catItem.sample_times;
    } else {
      timeSteps = Array.from({ length: 12 }, (_, i) => `2023-${String(i + 1).padStart(2, '0')}-01`);
    }
  }

  const varKeys = Object.keys(state.ncData.variables).filter(
    k => !["x", "y", "lat", "lon", "time", "datetime"].includes(k.toLowerCase())
  );

  // Check if exact cell has non-zero data
  let exactHasData = false;
  for (const vName of varKeys) {
    const data = state.ncData.variables[vName]?.data;
    if (!data) continue;
    for (let t = 0; t < timeSteps.length; t++) {
      const idx = t * (numY * numX) + nearestJ * numX + nearestI;
      if (data[idx] > 0 && data[idx] <= 1e30) { exactHasData = true; break; }
    }
    if (exactHasData) break;
  }

  let activeJ = nearestJ;
  let activeI = nearestI;
  let snappedToFog = false;
  let snapDistanceKm = 0;

  // If exact cell is all zeros, search neighborhood radius R = 6 cells (~4-5 km) for closest cell with fog data
  if (!exactHasData) {
    const R = 6;
    let minSquareDist = Infinity;
    let foundJ = nearestJ;
    let foundI = nearestI;

    const jMin = Math.max(0, nearestJ - R);
    const jMax = Math.min(numY - 1, nearestJ + R);
    const iMin = Math.max(0, nearestI - R);
    const iMax = Math.min(numX - 1, nearestI + R);

    for (let j = jMin; j <= jMax; j++) {
      for (let i = iMin; i <= iMax; i++) {
        let cellHasData = false;
        for (const vName of varKeys) {
          const data = state.ncData.variables[vName]?.data;
          if (!data) continue;
          for (let t = 0; t < timeSteps.length; t++) {
            const idx = t * (numY * numX) + j * numX + i;
            if (data[idx] > 0 && data[idx] <= 1e30) { cellHasData = true; break; }
          }
          if (cellHasData) break;
        }

        if (cellHasData) {
          const distSq = (j - nearestJ) * (j - nearestJ) + (i - nearestI) * (i - nearestI);
          if (distSq < minSquareDist) {
            minSquareDist = distSq;
            foundJ = j;
            foundI = i;
          }
        }
      }
    }

    if (minSquareDist < Infinity) {
      activeJ = foundJ;
      activeI = foundI;
      snappedToFog = true;
      const cellDist = Math.sqrt(minSquareDist);
      snapDistanceKm = parseFloat((cellDist * 0.8).toFixed(1));
      if (snapDistanceKm < 0.1) snapDistanceKm = 0.1;
      console.log(`Clic exacto (j:${nearestJ}, i:${nearestI}) sin datos -> Ajustado a celda con niebla (j:${activeJ}, i:${activeI}) a ~${snapDistanceKm} km`);
    }
  }

  const nearestGridX = xArr[activeI];
  const nearestGridY = yArr[activeJ];

  const extracted = {};

  varKeys.forEach((varName) => {
    const vObj = state.ncData.variables[varName];
    const data = vObj.data;
    const values = [];

    for (let t = 0; t < timeSteps.length; t++) {
      let val = null;
      if (data) {
        if (vObj.dimensions && vObj.dimensions.length === 3) {
          const idx = t * (numY * numX) + activeJ * numX + activeI;
          const raw = data[idx];
          if (raw !== undefined && !isNaN(raw) && raw <= 1e30) val = raw;
        } else if (vObj.dimensions && vObj.dimensions.length === 2) {
          const idx = activeJ * numX + activeI;
          const raw = data[idx];
          if (raw !== undefined && !isNaN(raw) && raw <= 1e30) val = raw;
        } else if (data[t] !== undefined && !isNaN(data[t]) && data[t] <= 1e30) {
          val = data[t];
        }
      }

      values.push(val !== null ? parseFloat(val.toFixed(6)) : null);
    }

    extracted[varName] = { values: values, units: vObj.units || vObj.attributes?.units || "" };
  });

  state.extractedTimeSeries = {
    targetX, targetY, nearestI, nearestJ, activeI, activeJ, nearestGridX, nearestGridY, snappedToFog, snapDistanceKm, timeSteps, extracted
  };

  updateMetadataUI();
  renderPlot();
}

function updateMetadataUI() {
  metaFileName.textContent = state.activeFilename || "-";
  metaLatLon.textContent = `${state.lat.toFixed(4)}°, ${state.lon.toFixed(4)}°`;

  if (state.extractedTimeSeries) {
    const ext = state.extractedTimeSeries;
    if (ext.snappedToFog) {
      metaGrid.textContent = `(i: ${ext.activeI}, j: ${ext.activeJ}) [📍 Niebla a ~${ext.snapDistanceKm} km]`;
    } else {
      metaGrid.textContent = `(i: ${ext.nearestI}, j: ${ext.nearestJ})`;
    }
    metaNearestCoords.textContent = `${ext.nearestGridX.toFixed(2)}, ${ext.nearestGridY.toFixed(2)}`;
    metaTimeCount.textContent = `${ext.timeSteps.length} pasos`;
  }
}

function renderPlot() {
  if (!state.extractedTimeSeries) return;

  const ext = state.extractedTimeSeries;
  const selectedVar = varSelect.value;
  const timeX = ext.timeSteps;

  const traces = [];
  const colors = ["#38bdf8", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
  let colorIdx = 0;

  Object.keys(ext.extracted).forEach((varName) => {
    if (selectedVar !== "all" && selectedVar !== varName) return;

    const vData = ext.extracted[varName];
    // Check if all values are null (no readable data at this point)
    const hasData = vData.values.some(v => v !== null);
    const allZero = hasData && vData.values.every(v => v === null || v === 0);

    traces.push({
      x: timeX,
      y: vData.values,
      type: "scatter",
      mode: "lines+markers",
      name: `${varName} ${vData.units ? "(" + vData.units + ")" : ""}` + (allZero ? " [sin datos en este punto]" : ""),
      connectgaps: false,
      line: { color: colors[colorIdx % colors.length], width: 2 },
      marker: { size: 5, color: colors[colorIdx % colors.length] }
    });
    colorIdx++;
  });

  // Detect if every extracted trace is entirely null/zero at this location
  const allTracesEmpty = Object.keys(ext.extracted).every(varName => {
    if (selectedVar !== "all" && selectedVar !== varName) return true;
    return ext.extracted[varName].values.every(v => v === null || v === 0);
  });

  const annotations = allTracesEmpty ? [{
    x: 0.5, y: 0.5,
    xref: "paper", yref: "paper",
    text: "Sin niebla registrada en este punto de la malla",
    font: { color: "#94a3b8", size: 14 },
    showarrow: false
  }] : [];

  let titleText = `Perfil Extraído: ${state.activeFilename} (Este: ${ext.targetX.toLocaleString()}, Norte: ${ext.targetY.toLocaleString()})`;
  if (ext.snappedToFog) {
    titleText += ` — 📍 Punto con niebla más cercano (~${ext.snapDistanceKm} km)`;
  }

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(15, 23, 42, 0.6)",
    font: { color: "#94a3b8", family: "Inter, sans-serif" },
    title: {
      text: titleText,
      font: { color: "#f8fafc", size: 12 }
    },
    xaxis: { title: "Tiempo / Fecha", type: "category", gridcolor: "rgba(255,255,255,0.05)" },
    yaxis: { title: "Valor de Variable", gridcolor: "rgba(255,255,255,0.05)", rangemode: "tozero" },
    margin: { l: 60, r: 30, t: 50, b: 50 },
    legend: { orientation: "h", y: 1.15 },
    annotations
  };

  Plotly.newPlot("plot-container", traces, layout, { responsive: true, displaylogo: false });
}

/**
 * Renderiza capa ráster del NetCDF activo sobre el mapa Leaflet.
 * Calcula la suma espacial sobre todos los pasos de tiempo y la dibuja
 * en un canvas HTML, luego lo superpone como ImageOverlay.
 */
function drawNetCDFOverlay() {
  if (!state.ncData) return;

  // Limpiar capas previas
  if (ncOverlayLayer) { map.removeLayer(ncOverlayLayer); ncOverlayLayer = null; }
  if (ncLegendControl) { map.removeControl(ncLegendControl); ncLegendControl = null; }

  const xArr = state.ncData.x;
  const yArr = state.ncData.y;
  if (!xArr || !yArr || xArr.length === 0 || yArr.length === 0) return;

  // Si es fallback indexado (sin datos reales), solo centrar el mapa
  if (state.ncData.isIndexedFallback) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const v of yArr) { if (v < minLat) minLat = v; if (v > maxLat) maxLat = v; }
    for (const v of xArr) { if (v < minLon) minLon = v; if (v > maxLon) maxLon = v; }
    map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [40, 40] });
    return;
  }

  const numX = xArr.length;
  const numY = yArr.length;

  // Determinar variable a renderizar
  const selectedVar = varSelect.value;
  const varNames = Object.keys(state.ncData.variables).filter(
    v => !["x", "y", "lat", "lon", "time", "datetime"].includes(v.toLowerCase())
  );
  if (!varNames.length) return;

  const varToPlot = (selectedVar !== "all" && varNames.includes(selectedVar))
    ? selectedVar : varNames[0];

  const vObj = state.ncData.variables[varToPlot];
  const data = vObj ? vObj.data : null;
  if (!data) return;

  statusText.textContent = "Generando mapa ráster...";

  // Calcular suma temporal → mapa 2D [j * numX + i]
  const grid2d = new Float32Array(numY * numX);

  if (vObj.dimensions && vObj.dimensions.length === 3) {
    // Inferir número real de pasos de tiempo a partir del tamaño del array
    const actualT = Math.round(data.length / (numY * numX));
    for (let t = 0; t < actualT; t++) {
      const base = t * numY * numX;
      for (let j = 0; j < numY; j++) {
        const rowBase = base + j * numX;
        for (let i = 0; i < numX; i++) {
          const raw = data[rowBase + i];
          if (raw > 0 && raw <= 1e30 && !isNaN(raw)) {
            grid2d[j * numX + i] += raw;
          }
        }
      }
    }
  } else if (vObj.dimensions && vObj.dimensions.length === 2) {
    for (let k = 0; k < grid2d.length && k < data.length; k++) {
      const raw = data[k];
      if (raw > 0 && raw <= 1e30 && !isNaN(raw)) grid2d[k] = raw;
    }
  }

  // Calcular valor máximo para normalización
  let maxVal = 0;
  for (let k = 0; k < grid2d.length; k++) {
    if (grid2d[k] > maxVal) maxVal = grid2d[k];
  }

  if (maxVal === 0) {
    statusText.textContent = `Cargado ${state.activeFilename} (sin datos no-cero en el área)`;
    return;
  }

  // Mapa de colores azules para datos de niebla/agua líquida
  function fogColormap(norm) {
    if (norm <= 0) return [0, 0, 0, 0]; // transparente
    const stops = [
      [0.001, [8,   48,  107, 30]],
      [0.15,  [8,   81,  156, 120]],
      [0.35,  [33,  113, 181, 175]],
      [0.60,  [66,  146, 198, 210]],
      [0.80,  [107, 174, 214, 235]],
      [1.00,  [198, 219, 239, 255]]
    ];
    for (let s = 1; s < stops.length; s++) {
      if (norm <= stops[s][0]) {
        const t = (norm - stops[s - 1][0]) / (stops[s][0] - stops[s - 1][0]);
        return stops[s - 1][1].map((v, i) => Math.round(v + t * (stops[s][1][i] - v)));
      }
    }
    return stops[stops.length - 1][1];
  }

  // Dibujar canvas
  const canvas = document.createElement("canvas");
  canvas.width = numX;
  canvas.height = numY;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(numX, numY);

  // Detectar orientación de latitud (si asciende o desciende con el índice)
  const latAscending = yArr.length > 1 && yArr[1] > yArr[0];

  for (let j = 0; j < numY; j++) {
    // El canvas row 0 debe ser el Norte (latitud máxima).
    // Si lat desciende (más común en NetCDF geoespacial): row 0 = North → dataJ = j
    // Si lat asciende: row 0 = South → hay que invertir
    const dataJ = latAscending ? (numY - 1 - j) : j;
    const rowBase = dataJ * numX;
    const canvasBase = j * numX;
    for (let i = 0; i < numX; i++) {
      const norm = grid2d[rowBase + i] / maxVal;
      const [r, g, b, a] = fogColormap(norm);
      const px = (canvasBase + i) * 4;
      imgData.data[px]     = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = a;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Calcular bounding box geográfico
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const v of yArr) { if (v < minLat) minLat = v; if (v > maxLat) maxLat = v; }
  for (const v of xArr) { if (v < minLon) minLon = v; if (v > maxLon) maxLon = v; }

  // Agregar overlay al mapa
  const imageUrl = canvas.toDataURL("image/png");
  ncOverlayLayer = L.imageOverlay(imageUrl, [[minLat, minLon], [maxLat, maxLon]], {
    opacity: 0.82,
    interactive: false,
    zIndex: 200
  }).addTo(map);

  // Ajustar vista del mapa a los límites del dataset
  map.fitBounds([[minLat, minLon], [maxLat, maxLon]], { padding: [40, 40] });

  // Agregar leyenda de color
  const units = (vObj.units || vObj.attributes?.units || "").trim();
  ncLegendControl = L.control({ position: "bottomright" });
  ncLegendControl.onAdd = function () {
    const div = L.DomUtil.create("div", "nc-raster-legend");
    div.innerHTML = `
      <div style="
        background: rgba(15,23,42,0.88);
        padding: 10px 14px;
        border-radius: 10px;
        border: 1px solid rgba(56,189,248,0.35);
        font-family: Inter, sans-serif;
        color: #94a3b8;
        font-size: 12px;
        min-width: 150px;
        backdrop-filter: blur(6px);
      ">
        <div style="font-weight:600;color:#f8fafc;margin-bottom:6px;">
          ${varToPlot}${units ? " ("+units+")" : ""}
        </div>
        <div style="
          width:100%;
          height:12px;
          border-radius:4px;
          background: linear-gradient(to right,
            rgba(8,48,107,0.4),
            rgb(33,110,180),
            rgb(107,174,214),
            rgb(198,219,239)
          );
          margin-bottom:4px;
        "></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;">
          <span>0</span>
          <span>${maxVal.toFixed(2)}</span>
        </div>
        <div style="margin-top:5px;font-size:10px;color:#64748b;">Σ anual (todos los meses)</div>
      </div>
    `;
    return div;
  };
  ncLegendControl.addTo(map);

  statusText.textContent = `Mapa ráster: ${varToPlot} — ${state.activeFilename}`;
}

function exportToExcel() {
  if (!state.extractedTimeSeries) {
    alert("Por favor consulta los datos primero.");
    return;
  }

  const ext = state.extractedTimeSeries;
  const dataRows = [];

  for (let t = 0; t < ext.timeSteps.length; t++) {
    const row = {
      "Tiempo / Paso": ext.timeSteps[t],
      "Este Objetivo (X)": ext.targetX,
      "Norte Objetivo (Y)": ext.targetY,
      "Este Malla Cercana": ext.nearestGridX,
      "Norte Malla Cercana": ext.nearestGridY
    };

    Object.keys(ext.extracted).forEach((varName) => {
      row[varName] = ext.extracted[varName].values[t];
    });

    dataRows.push(row);
  }

  const worksheetData = XLSX.utils.json_to_sheet(dataRows);

  const metaRows = [
    { Propiedad: "Nombre del Dataset", Valor: state.activeFilename },
    { Propiedad: "SRC Seleccionado", Valor: state.selectedCrs },
    { Propiedad: "Este Objetivo (X)", Valor: ext.targetX },
    { Propiedad: "Norte Objetivo (Y)", Valor: ext.targetY },
    { Propiedad: "Latitud Calculada", Valor: state.lat },
    { Propiedad: "Longitud Calculada", Valor: state.lon },
    { Propiedad: "Índice i Malla (Columna)", Valor: ext.nearestI },
    { Propiedad: "Índice j Malla (Fila)", Valor: ext.nearestJ },
    { Propiedad: "Este Malla Cercana", Valor: ext.nearestGridX },
    { Propiedad: "Norte Malla Cercana", Valor: ext.nearestGridY },
    { Propiedad: "Total Pasos de Tiempo", Valor: ext.timeSteps.length },
    { Propiedad: "Fecha de Exportación", Valor: new Date().toISOString() }
  ];

  const worksheetMeta = XLSX.utils.json_to_sheet(metaRows);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheetData, "Series de Tiempo");
  XLSX.utils.book_append_sheet(workbook, worksheetMeta, "Metadatos");

  const fname = `AMARU_Extraccion_${state.activeFilename.replace('.nc','')}_X${Math.round(ext.targetX)}_Y${Math.round(ext.targetY)}.xlsx`;
  XLSX.writeFile(workbook, fname);
  statusText.textContent = "¡Excel Descargado!";
}
