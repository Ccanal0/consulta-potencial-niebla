/**
 * Explorador Espacial NetCDF AMARU
 * Motor Universal WebAssembly HDF5 / NetCDF4 y NetCDF3 (Frontend en Español)
 * Versión: CELDAS-EXACTAS-2026-08-31 — mapa reproyectado, ceros transparentes.
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
  h5wasmReady: false,
  isLoading: false,
  requestedFilename: null
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
let selectedCellLayer = null;
let coordinateInputTimer = null;
let loadSequence = 0;
let lastFittedDataset = null;
const gridGeometryCache = new WeakMap();
const variableReaderCache = new WeakMap();
const layerSummaryCache = new WeakMap();
const APP_VERSION = "CELDAS-EXACTAS-2026-08-31";

function createMapMarkerIcon(color = "#38bdf8", label = "") {
  return L.divIcon({
    className: "custom-map-marker",
    html: `<div style="
      background:${color};
      width:22px;
      height:22px;
      border-radius:50%;
      border:3px solid #ffffff;
      box-shadow:0 0 0 2px rgba(15,23,42,0.75),0 0 14px ${color};
      display:flex;
      align-items:center;
      justify-content:center;
      color:#ffffff;
      font:bold 11px Inter,sans-serif;
    ">${label}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14]
  });
}

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
  map = L.map("map", { center: [-30.0, -71.0], zoom: 6, maxZoom: 19 });
  map.createPane("amaruLabels");
  map.getPane("amaruLabels").style.zIndex = 450;
  map.getPane("amaruLabels").style.pointerEvents = "none";

  // Atenuar el verde y el azul del fondo satelital permite que la capa de
  // niebla cálida se distinga con claridad. La alternativa de color original
  // continúa disponible en el selector de capas.
  if (!document.getElementById("amaru-map-contrast-style")) {
    const contrastStyle = document.createElement("style");
    contrastStyle.id = "amaru-map-contrast-style";
    contrastStyle.textContent = `
      .amaru-satellite-contrast {
        filter: grayscale(48%) saturate(52%) brightness(68%) contrast(118%);
      }
      .amaru-fog-raster {
        image-rendering: pixelated;
        image-rendering: crisp-edges;
      }
      .amaru-cell-tooltip {
        background: rgba(15,23,42,0.96);
        border: 1px solid rgba(255,255,255,0.65);
        color: #f8fafc;
        box-shadow: 0 6px 20px rgba(0,0,0,0.35);
        font: 600 12px Inter,sans-serif;
      }
      .amaru-cell-tooltip::before {
        border-top-color: rgba(15,23,42,0.96) !important;
      }
    `;
    document.head.appendChild(contrastStyle);
  }

  const satelliteUrl =
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const labelsUrl =
    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

  // Mapa base sin API Key. El modo híbrido combina imagen satelital y
  // referencias geográficas; el usuario puede cambiarlo a color original.
  const sateliteContraste = L.tileLayer(
    satelliteUrl,
    {
      maxZoom: 19,
      attribution: "Tiles © Esri",
      className: "amaru-satellite-contrast"
    }
  );

  const etiquetasContraste = L.tileLayer(
    labelsUrl,
    {
      maxZoom: 19,
      attribution: "Labels © Esri", pane: "amaruLabels"
    }
  );

  const mapaHibridoContraste = L.layerGroup([sateliteContraste, etiquetasContraste]);

  const sateliteOriginal = L.tileLayer(
    satelliteUrl,
    {
      maxZoom: 19,
      attribution: "Tiles © Esri"
    }
  );

  const etiquetasOriginal = L.tileLayer(
    labelsUrl,
    {
      maxZoom: 19,
      attribution: "Labels © Esri", pane: "amaruLabels"
    }
  );

  const mapaHibridoOriginal = L.layerGroup([sateliteOriginal, etiquetasOriginal]);

  const mapaCallejero = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors"
    }
  );

  mapaHibridoContraste.addTo(map);

  L.control.layers(
    {
      "Satélite — contraste de niebla": mapaHibridoContraste,
      "Satélite — color original": mapaHibridoOriginal,
      "Mapa callejero": mapaCallejero
    },
    {},
    { position: "topright", collapsed: true }
  ).addTo(map);

  regionPolygonsGroup = L.layerGroup().addTo(map);

  // Pane independiente: mantiene el contorno de la celda consultada por
  // encima del ráster, pero por debajo del marcador y sus etiquetas.
  map.createPane("selectedCellPane");
  map.getPane("selectedCellPane").style.zIndex = 590;
  map.getPane("selectedCellPane").style.pointerEvents = "none";

  marker = L.marker([-33.4372, -70.6506], {
    draggable: true,
    icon: createMapMarkerIcon()
  }).addTo(map);

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

  // Evita recalcular el gráfico en cada tecla mientras el usuario escribe.
  // La consulta se ejecuta 300 ms después de la última modificación.
  const scheduleCoordinateQuery = () => {
    window.clearTimeout(coordinateInputTimer);
    coordinateInputTimer = window.setTimeout(updateCoordsFromInputs, 300);
  };
  eastingInput.addEventListener("input", scheduleCoordinateQuery);
  northingInput.addEventListener("input", scheduleCoordinateQuery);

  datasetSelect.addEventListener("change", () => {
    const selected = datasetSelect.value;
    if (selected !== "AUTO") {
      fetchAndLoadNetCDF(selected);
    } else {
      autoDetectAndLoadRegion();
    }
  });

  btnExtract.addEventListener("click", () => {
    window.clearTimeout(coordinateInputTimer);
    updateCoordsFromInputs();
  });

  btnExportExcel.disabled = true;
  btnExportExcel.addEventListener("click", () => {
    window.clearTimeout(coordinateInputTimer);
    updateCoordsFromInputs();
    if (!state.isLoading && state.extractedTimeSeries) exportToExcel();
  });

  varSelect.addEventListener("change", () => {
    renderPlot();
    drawNetCDFOverlay();
    drawSelectedGridCell();
  });
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
      color: "#64748b", weight: 1, fill: false
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
  if (state.isLoading && state.requestedFilename === filename) return;
  if (!state.isLoading && state.activeFilename === filename && state.ncData && !state.ncData.isIndexedFallback) {
    queryAndPlot(); return;
  }
  const request = ++loadSequence;
  state.requestedFilename = filename; state.isLoading = true;
  state.ncData = null;
  lastFittedDataset = null;
  clearCurrentQuery("Cargando " + filename + "...");
  removeFogOverlay();
  btnExtract.disabled = true; varSelect.disabled = true;
  loadedFileInfo.style.display = "none";
  try {
    await waitForH5Wasm(12000);
    if (request !== loadSequence) return;
    let buffer = state.ncCache.get(filename);
    if (!buffer) {
      const response = await fetch("data/" + filename);
      if (!response.ok) throw new Error("HTTP " + response.status);
      buffer = await response.arrayBuffer();
      if (request !== loadSequence) return;
      state.ncCache.set(filename, buffer);
      while (state.ncCache.size > 2) state.ncCache.delete(state.ncCache.keys().next().value);
    }
    const parsed = await parseUniversalNetCDF(buffer, filename);
    if (request !== loadSequence) return;
    // Comprobar antes de publicar un dataset nuevo en el estado de la pantalla.
    getGridGeometry(parsed);
    for (const name of getDataVariableNames(parsed)) getVariableReader(parsed, name);
    state.ncData = parsed; state.activeFilename = filename; state.isLoading = false;
    fileNameDisplay.textContent = filename; loadedFileInfo.style.display = "block";
    btnExtract.disabled = false; varSelect.disabled = false;
    populateVariableSelect(); queryAndPlot(); drawNetCDFOverlay();
  } catch (error) {
    if (request !== loadSequence) return;
    console.error("Fallo al procesar NetCDF:", error);
    state.isLoading = false; state.ncData = null;
    btnExtract.disabled = false; varSelect.disabled = false;
    clearCurrentQuery("No se pudo cargar " + filename + ": " + error.message);
    // Un índice sin valores originales no debe producir falsos ceros.
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
        const result = {}, source = item?.attrs;
        if (!source) return result;
        const names = typeof source.keys === "function" ? Array.from(source.keys()) : Object.keys(source);
        for (const name of names) {
          try {
            const attribute = typeof source.get === "function" ? source.get(name) : source[name];
            let value = attribute?.value;
            if (typeof value === "string") value = value.replace(/\0/g, "").trim();
            else if (ArrayBuffer.isView(value) || Array.isArray(value)) {
              // Los metadatos numéricos (FillValue, scale_factor...) no son texto.
              const textAttribute = ["units", "calendar", "calendar_type", "long_name", "standard_name"].includes(name);
              value = textAttribute && value instanceof Uint8Array
                ? new TextDecoder().decode(value).replace(/\0/g, "").trim()
                : Array.from(value);
              if (Array.isArray(value) && value.length === 1) value = value[0];
            }
            result[name] = value;
          } catch (_) {}
        }
        return result;
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
            vars[key] = { name: key, shape: Array.from(item.shape || []), dimensions: item.shape, data: data, units: attrs.units || "", attributes: attrs };
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
      FS.unlink(safeName); // liberar la copia comprimida alojada en WASM

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
        shape: v.dimensions.map(id => ncReader.dimensions[id].size),
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

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    clearCurrentQuery("Completa ambas coordenadas con números válidos."); return;
  }

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
    } catch (e) { clearCurrentQuery("No se pudieron transformar las coordenadas."); return; }
  }

  if (!Number.isFinite(state.lat) || !Number.isFinite(state.lon) || Math.abs(state.lat) > 85 || Math.abs(state.lon) > 180) {
    clearCurrentQuery("Las coordenadas no corresponden a una ubicación válida."); return;
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
  const previous = varSelect.value;
  varSelect.innerHTML = '<option value="all">Todas las Variables</option>';
  for (const name of getDataVariableNames()) {
    const option = document.createElement("option");
    option.value = name; option.textContent = name; varSelect.appendChild(option);
  }
  varSelect.value = getDataVariableNames().includes(previous) ? previous : "all";
}

// Todos los consumidores usan los mismos índices y valores originales.
// Los cachés pertenecen al dataset; al cambiar de archivo pueden liberarse.
function getDataVariableNames(nc = state.ncData) {
  if (!nc || !nc.variables) return [];
  const coordinates = new Set(["x", "y", "lat", "lon", "latitude", "longitude",
    "easting", "northing", "time", "datetime", "date", "crs", "spatial_ref"]);
  return Object.keys(nc.variables).filter(name => !coordinates.has(name.toLowerCase())
    && nc.variables[name].dimensions?.length >= 2);
}

function buildAxisInfo(values) {
  if (!values || !values.length) throw new Error("Falta un eje espacial del NetCDF.");
  const n = values.length, first = Number(values[0]);
  const step = n > 1 ? Number(values[1]) - first : 0.0001;
  if (!Number.isFinite(first) || !Number.isFinite(step) || step === 0)
    throw new Error("El eje espacial contiene coordenadas inválidas.");
  let regular = true;
  for (let k = 1; k < n; k++) {
    const delta = Number(values[k]) - Number(values[k - 1]);
    if (!Number.isFinite(delta) || delta * step <= 0)
      throw new Error("Las coordenadas del NetCDF deben ser monótonas.");
    if (Math.abs(delta - step) > Math.abs(step) * 1e-6) regular = false;
  }
  const bounds = getGridExtentEdges(values);
  return { values, n, first, step, regular, ascending: step > 0,
    min: bounds[0], max: bounds[1] };
}

function nearestAxisIndex(axis, coordinate) {
  if (!Number.isFinite(coordinate) || coordinate < axis.min || coordinate > axis.max) return -1;
  if (axis.n === 1) return 0;
  let low, high;
  if (axis.regular) {
    low = Math.max(0, Math.min(axis.n - 1, Math.floor((coordinate - axis.first) / axis.step)));
    high = Math.min(axis.n - 1, low + 1);
  } else {
    low = 0; high = axis.n - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if ((coordinate > axis.values[middle]) === axis.ascending) low = middle;
      else high = middle;
    }
  }
  // En un empate se mantiene el primer índice, igual que en la consulta original.
  return Math.abs(coordinate - axis.values[low]) <= Math.abs(coordinate - axis.values[high])
    ? low : high;
}

function getGridGeometry(nc = state.ncData) {
  if (!nc) throw new Error("Todavía no hay un NetCDF cargado.");
  if (gridGeometryCache.has(nc)) return gridGeometryCache.get(nc);
  const x = buildAxisInfo(nc.x), y = buildAxisInfo(nc.y);
  // Los NetCDF regionales AMARU usan lon/lat. No se adivina un CRS para
  // archivos proyectados, porque hacerlo podría dibujar datos en otro lugar.
  if (x.min < -180 || x.max > 180 || y.min < -85.051129 || y.max > 85.051129)
    throw new Error("Este visor requiere la malla AMARU en longitud/latitud.");
  const geometry = { x, y, width: x.n, height: y.n, size: x.n * y.n,
    bounds: [[y.min, x.min], [y.max, x.max]] };
  gridGeometryCache.set(nc, geometry);
  return geometry;
}

function numericAttribute(attributes, name, fallback) {
  const found = Array.isArray(attributes)
    ? attributes.find(item => item.name === name)?.value : attributes?.[name];
  const value = ArrayBuffer.isView(found) || Array.isArray(found) ? found[0] : found;
  if (value === undefined || value === null || value === "") return fallback;
  return Number(value);
}

function getVariableReader(nc, name) {
  let cached = variableReaderCache.get(nc);
  if (!cached) { cached = new Map(); variableReaderCache.set(nc, cached); }
  if (cached.has(name)) return cached.get(name);
  const variable = nc.variables[name], geometry = getGridGeometry(nc);
  if (!variable?.data || nc.isIndexedFallback)
    throw new Error("Se necesita el NetCDF completo para consultar valores originales.");
  const data = variable.data, rank = variable.dimensions?.length;
  const steps = rank === 3 ? data.length / geometry.size : 1;
  if ((rank !== 2 && rank !== 3) || !Number.isInteger(steps) || steps < 1 ||
      data.length !== steps * geometry.size)
    throw new Error("La forma de la variable " + name + " no coincide con la malla.");
  if (variable.shape && (variable.shape[rank - 1] !== geometry.width ||
      variable.shape[rank - 2] !== geometry.height))
    throw new Error("Orden espacial no compatible en " + name + ": se espera tiempo, latitud, longitud.");
  const fill = numericAttribute(variable.attributes, "_FillValue", NaN);
  const missing = numericAttribute(variable.attributes, "missing_value", NaN);
  const scale = numericAttribute(variable.attributes, "scale_factor", 1);
  const offset = numericAttribute(variable.attributes, "add_offset", 0);
  const isFiniteNumber = Number.isFinite, absolute = Math.abs;
  const stride = rank === 3 ? geometry.size : 0;
  const reader = {
    steps, size: geometry.size, units: String(variable.units || variable.attributes?.units || ""),
    read(t, cell) {
      const raw = data[t * stride + cell];
      if (typeof raw !== "number" || !isFiniteNumber(raw) || absolute(raw) > 1e30 ||
          raw === fill || raw === missing) return null;
      const value = raw * scale + offset;
      // Wh y LWC no admiten valores físicos negativos.
      return isFiniteNumber(value) && value >= 0 ? value : null;
    }
  };
  cached.set(name, reader);
  return reader;
}

function aggregateMonthlyValues(values, variable) {
  let sum = 0, count = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      sum += value; count++;
    }
  }
  return { value: count ? (variable.toLowerCase() === "wh" ? sum : sum / count) : null,
    count };
}

function getLayerSummary(nc, name) {
  let cached = layerSummaryCache.get(nc);
  if (!cached) { cached = new Map(); layerSummaryCache.set(nc, cached); }
  if (cached.has(name)) return cached.get(name);
  const geometry = getGridGeometry(nc), reader = getVariableReader(nc, name);
  const values = new Float64Array(geometry.size), counts = new Uint32Array(geometry.size);
  // Recorrido secuencial de memoria; se calcula una sola vez por variable.
  const read = reader.read;
  for (let t = 0; t < reader.steps; t++) {
    for (let cell = 0; cell < geometry.size; cell++) {
      const value = read(t, cell);
      if (value !== null) { values[cell] += value; counts[cell]++; }
    }
  }
  const useSum = name.toLowerCase() === "wh";
  let valid = 0, positive = 0;
  for (let cell = 0; cell < values.length; cell++) {
    if (!counts[cell]) { values[cell] = NaN; continue; }
    if (!useSum) values[cell] /= counts[cell];
    valid++;
    if (values[cell] > 0) positive++;
  }
  const positiveValues = new Float64Array(positive);
  for (let cell = 0, k = 0; cell < values.length; cell++)
    if (values[cell] > 0) positiveValues[k++] = values[cell];
  positiveValues.sort();
  const zeros = valid - positive;
  const quantile = proportion => {
    if (!valid) return null;
    const index = (valid - 1) * proportion, lo = Math.floor(index), hi = Math.ceil(index);
    const at = i => i < zeros ? 0 : positiveValues[i - zeros];
    return at(lo) * (1 - (index - lo)) + at(hi) * (index - lo);
  };
  const summary = { geometry, values, name, steps: reader.steps, useSum,
    units: reader.units, displayMax: positiveValues[Math.floor((positive - 1) * 0.98)] || 0,
    statistics: { nValidos: valid, nPositivos: positive,
      porcentajePositivo: valid ? redondear(positive / valid * 100, 6) : 0,
      minimoPositivo: positive ? positiveValues[0] : null,
      p25: quantile(0.25), mediana: quantile(0.5), p75: quantile(0.75),
      p90: quantile(0.9), maximo: valid ? (positive ? positiveValues[positive - 1] : 0) : null } };
  cached.set(name, summary);
  return summary;
}

function formatFogValue(value) {
  if (value === null || !Number.isFinite(value)) return "Sin dato";
  if (value > 0 && value < 0.0001) return value.toExponential(3);
  return value.toLocaleString("es-CL", { maximumFractionDigits: 4 });
}

function getTimeLabels(nc, count) {
  if (nc.time?.length === count && nc.time.some(value => isNaN(Number(value))))
    return Array.from(nc.time);
  const catalogEntry = state.catalog.find(item => item.filename === state.activeFilename);
  if (catalogEntry?.sample_times?.length === count) return [...catalogEntry.sample_times];
  // No inventar meses/años si faltan los metadatos temporales.
  return Array.from({ length: count }, (_, i) => "Paso " + (i + 1));
}

function clearCurrentQuery(message) {
  state.extractedTimeSeries = null;
  btnExportExcel.disabled = true;
  if (selectedCellLayer) { map.removeLayer(selectedCellLayer); selectedCellLayer = null; }
  if (marker) { marker.unbindTooltip(); marker.setIcon(createMapMarkerIcon("#64748b", "?")); }
  if (typeof Plotly !== "undefined") Plotly.purge(document.getElementById("plot-container"));
  metaGrid.textContent = "-"; metaNearestCoords.textContent = "-"; metaTimeCount.textContent = "-";
  statusText.textContent = message;
}

function queryAndPlot() {
  if (state.isLoading) return;
  if (!state.ncData) { clearCurrentQuery("Esperando la carga del archivo NetCDF..."); return; }
  try {
    const geometry = getGridGeometry(), nc = state.ncData;
    const activeI = nearestAxisIndex(geometry.x, state.lon);
    const activeJ = nearestAxisIndex(geometry.y, state.lat);
    if (activeI < 0 || activeJ < 0) {
      clearCurrentQuery("La coordenada está fuera de la malla del archivo seleccionado.");
      return;
    }
    const names = getDataVariableNames(), extracted = {};
    if (!names.length) throw new Error("No hay variables espaciales disponibles.");
    const steps = getVariableReader(nc, names[0]).steps;
    const timeSteps = getTimeLabels(nc, steps), cell = activeJ * geometry.width + activeI;
    for (const name of names) {
      const reader = getVariableReader(nc, name);
      if (reader.steps !== steps) throw new Error("Las variables tienen distintos períodos.");
      const values = Array.from({ length: steps }, (_, t) => reader.read(t, cell));
      // Se conserva la precisión del dato; el formato visual no cambia los valores.
      extracted[name] = { values, units: reader.units };
    }
    state.extractedTimeSeries = {
      targetX: state.easting, targetY: state.northing,
      nearestI: activeI, nearestJ: activeJ, activeI, activeJ,
      nearestGridX: nc.x[activeI], nearestGridY: nc.y[activeJ],
      snappedToFog: false, snapDistanceKm: 0, timeSteps, extracted
    };
    btnExportExcel.disabled = false;
    updateMetadataUI(); renderPlot();
    const selected = drawSelectedGridCell();
    statusText.textContent = "Consulta actualizada: Lat " + state.lat.toFixed(4) +
      ", Lon " + state.lon.toFixed(4) + (selected ? " · " + selected.variable + ": " + selected.formattedValue : "");
  } catch (error) {
    console.error(error);
    clearCurrentQuery("No se puede consultar: " + error.message);
  }
}

function getMapVariableName() {
  if (!state.ncData || !state.ncData.variables) return null;
  const varNames = getDataVariableNames();
  if (!varNames.length) return null;

  const selectedVar = varSelect ? varSelect.value : "all";
  if (selectedVar !== "all" && varNames.includes(selectedVar)) return selectedVar;

  // Con "Todas las variables", el mapa representa Wh para coincidir con el
  // potencial exportado al Excel. LWC continúa disponible en el selector.
  return varNames.find(name => name.toLowerCase() === "wh") || varNames[0];
}

function getGridCellEdges(values, index) {
  if (!values || !values.length || index < 0 || index >= values.length) return null;
  const center = Number(values[index]);
  if (!Number.isFinite(center)) return null;

  if (values.length === 1) return [center - 0.00005, center + 0.00005];

  const previous = index > 0
    ? Number(values[index - 1])
    : center - (Number(values[index + 1]) - center);
  const next = index < values.length - 1
    ? Number(values[index + 1])
    : center + (center - Number(values[index - 1]));
  const edgeA = (previous + center) / 2;
  const edgeB = (center + next) / 2;
  return [Math.min(edgeA, edgeB), Math.max(edgeA, edgeB)];
}

function getGridExtentEdges(values) {
  if (!values || !values.length) return null;
  if (values.length === 1) {
    const value = Number(values[0]);
    return [value - 0.00005, value + 0.00005];
  }

  const first = Number(values[0]);
  const second = Number(values[1]);
  const last = Number(values[values.length - 1]);
  const penultimate = Number(values[values.length - 2]);
  const firstEdge = first - (second - first) / 2;
  const lastEdge = last + (last - penultimate) / 2;
  return [Math.min(firstEdge, lastEdge), Math.max(firstEdge, lastEdge)];
}

function drawSelectedGridCell() {
  if (!map || !state.ncData || !state.extractedTimeSeries) return null;
  if (selectedCellLayer) { map.removeLayer(selectedCellLayer); selectedCellLayer = null; }
  const ext = state.extractedTimeSeries, variable = getMapVariableName();
  const series = ext.extracted[variable];
  if (!series) return null;
  const xEdges = getGridCellEdges(state.ncData.x, ext.activeI);
  const yEdges = getGridCellEdges(state.ncData.y, ext.activeJ);
  const aggregate = aggregateMonthlyValues(series.values, variable);
  const value = aggregate.value, positive = value !== null && value > 0;
  const color = value === null ? "#94a3b8" : positive ? "#ffffff" : "#94a3b8";
  // Solo contorno: nunca se tapa el mapa con una máscara alrededor del clic.
  selectedCellLayer = L.rectangle([[yEdges[0], xEdges[0]], [yEdges[1], xEdges[1]]], {
    pane: "selectedCellPane", color, weight: 2, opacity: 0.95, fill: false,
    dashArray: positive ? null : "4 4", interactive: false
  }).addTo(map);
  marker.setIcon(createMapMarkerIcon(positive ? "#22c55e" : "#64748b",
    value === null ? "?" : positive ? "✓" : "0"));
  const period = variable.toLowerCase() === "wh" ? "Suma del período" : "Promedio del período";
  const units = series.units ? " " + series.units : "";
  const formattedValue = formatFogValue(value);
  marker.unbindTooltip();
  marker.bindTooltip(
    "<b>Celda original consultada</b><br>" + variable + " · " + period + ": " +
    formattedValue + (value === null ? "" : units) + "<br>" +
    aggregate.count + "/" + series.values.length + " meses válidos<br>" +
    "i=" + ext.activeI + ", j=" + ext.activeJ,
    { direction: "top", offset: [0, -14], className: "amaru-cell-tooltip", opacity: 1 }
  );
  return { variable, annualValue: value, formattedValue: formattedValue + (value === null ? "" : units) };
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
    metaNearestCoords.textContent = `${ext.nearestGridX.toFixed(6)}, ${ext.nearestGridY.toFixed(6)}`;
    metaTimeCount.textContent = `${ext.timeSteps.length} pasos`;
  }
}

function renderPlot() {
  if (!state.extractedTimeSeries) return;

  const ext = state.extractedTimeSeries;
  const selectedVar = varSelect.value;
  const timeX = ext.timeSteps;
  const monthNames = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const timeLabels = timeX.map((value, index) => {
    const match = String(value).match(/((?:19|20)\d{2})-(\d{2})/);
    if (!match) return String(value);
    const monthIndex = Math.max(0, Math.min(11, Number(match[2]) - 1));
    return `${monthNames[monthIndex]} ${match[1]}`;
  });

  const traces = [];
  const colors = ["#38bdf8", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];
  const fillColors = ["rgba(56,189,248,0.10)", "rgba(16,185,129,0.10)", "rgba(245,158,11,0.10)", "rgba(139,92,246,0.10)", "rgba(236,72,153,0.10)"];
  let colorIdx = 0;

  const selectedNames = Object.keys(ext.extracted).filter(
    varName => selectedVar === "all" || selectedVar === varName
  );
  const hasWh = selectedNames.some(name => name.toLowerCase() === "wh");
  const hasOtherVariable = selectedNames.some(name => name.toLowerCase() !== "wh");
  const useSecondAxis = hasWh && hasOtherVariable;

  selectedNames.forEach((varName) => {
    const vData = ext.extracted[varName];
    const hasData = vData.values.some(v => typeof v === "number" && Number.isFinite(v));
    const allZero = hasData && vData.values.every(v => v === null || v === 0);
    const traceUsesSecondAxis = useSecondAxis && varName.toLowerCase() === "wh";

    traces.push({
      x: timeLabels,
      y: vData.values,
      type: "scatter",
      mode: "lines+markers",
      name: `${varName} ${vData.units ? "(" + vData.units + ")" : ""}` + (allZero ? " [valor 0]" : ""),
      connectgaps: false,
      line: { color: colors[colorIdx % colors.length], width: 3 },
      marker: {
        size: 7,
        color: colors[colorIdx % colors.length],
        line: { color: "#e2e8f0", width: 1 }
      },
      fill: "tozeroy",
      fillcolor: fillColors[colorIdx % fillColors.length],
      yaxis: traceUsesSecondAxis ? "y2" : "y",
      customdata: timeX,
      hovertemplate:
        `<b>${varName}</b><br>` +
        `Fecha: %{customdata}<br>` +
        `Valor: %{y:.6~g}${vData.units ? " " + vData.units : ""}<extra></extra>`
    });
    colorIdx++;
  });

  const selectedValues = selectedNames.flatMap(varName => ext.extracted[varName].values);
  const hasAnyValidValue = selectedValues.some(v => typeof v === "number" && Number.isFinite(v));
  const hasAnyPositiveValue = selectedValues.some(v => typeof v === "number" && Number.isFinite(v) && v > 0);

  const emptyMessage = !hasAnyValidValue
    ? "No hay datos legibles en la celda original seleccionada"
    : !hasAnyPositiveValue
      ? "Los valores válidos de esta celda son cero en el modelo AMARU"
      : null;

  const annotations = emptyMessage ? [{
    x: 0.5, y: 0.5,
    xref: "paper", yref: "paper",
    text: emptyMessage,
    font: { color: "#cbd5e1", size: 15 },
    bgcolor: "rgba(15,23,42,0.88)",
    bordercolor: "rgba(56,189,248,0.45)",
    borderwidth: 1,
    borderpad: 10,
    showarrow: false
  }] : [];

  let titleText = `Perfil Extraído: ${state.activeFilename} (Este: ${ext.targetX.toLocaleString()}, Norte: ${ext.targetY.toLocaleString()})`;
  if (ext.snappedToFog) {
    titleText += ` — 📍 Punto con niebla más cercano (~${ext.snapDistanceKm} km)`;
  }

  const primaryName = selectedNames.find(name => !useSecondAxis || name.toLowerCase() !== "wh") || selectedNames[0] || "Variable";
  const primaryUnits = ext.extracted[primaryName]?.units || "";
  const whName = selectedNames.find(name => name.toLowerCase() === "wh");
  const whUnits = whName ? (ext.extracted[whName]?.units || "") : "";

  const yAxisCommon = {
    showgrid: true,
    gridcolor: "rgba(148,163,184,0.20)",
    gridwidth: 1,
    showline: true,
    linecolor: "rgba(148,163,184,0.55)",
    linewidth: 1,
    zeroline: true,
    zerolinecolor: "rgba(226,232,240,0.55)",
    zerolinewidth: 1,
    tickfont: { color: "#cbd5e1", size: 12 },
    tickformat: ".4~g",
    automargin: true,
    rangemode: "tozero",
    fixedrange: false
  };

  const layout = {
    height: 460,
    autosize: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(15,23,42,0.78)",
    font: { color: "#cbd5e1", family: "Inter, sans-serif", size: 12 },
    title: {
      text: titleText,
      x: 0.5,
      xanchor: "center",
      y: 0.97,
      font: { color: "#f8fafc", size: 13 }
    },
    xaxis: {
      title: { text: "Mes", standoff: 18, font: { color: "#e2e8f0", size: 13 } },
      type: "category",
      categoryorder: "array",
      categoryarray: timeLabels,
      showgrid: true,
      gridcolor: "rgba(148,163,184,0.16)",
      showline: true,
      linecolor: "rgba(148,163,184,0.55)",
      tickfont: { color: "#cbd5e1", size: 11 },
      tickangle: -30,
      automargin: true,
      fixedrange: false
    },
    yaxis: {
      ...yAxisCommon,
      title: {
        text: `${primaryName}${primaryUnits ? " (" + primaryUnits + ")" : ""}`,
        standoff: 14,
        font: { color: "#e2e8f0", size: 13 }
      },
      ...(!hasAnyPositiveValue ? { range: [0, 1] } : {})
    },
    ...(useSecondAxis ? {
      yaxis2: {
        ...yAxisCommon,
        title: {
          text: `${whName}${whUnits ? " (" + whUnits + ")" : ""}`,
          standoff: 14,
          font: { color: "#e2e8f0", size: 13 }
        },
        overlaying: "y",
        side: "right",
        showgrid: false,
        ...(!hasAnyPositiveValue ? { range: [0, 1] } : {})
      }
    } : {}),
    margin: { l: 88, r: useSecondAxis ? 92 : 36, t: 92, b: 86, pad: 4 },
    legend: {
      orientation: "h",
      x: 0,
      y: 1.13,
      xanchor: "left",
      yanchor: "bottom",
      bgcolor: "rgba(15,23,42,0.65)",
      bordercolor: "rgba(148,163,184,0.20)",
      borderwidth: 1,
      font: { color: "#e2e8f0", size: 12 }
    },
    hovermode: "x unified",
    hoverlabel: {
      bgcolor: "#0f172a",
      bordercolor: "#38bdf8",
      font: { color: "#f8fafc", family: "Inter, sans-serif" }
    },
    annotations,
    transition: { duration: 250, easing: "cubic-in-out" }
  };

  const plotElement = document.getElementById("plot-container");
  const plotConfig = {
    responsive: true,
    displaylogo: false,
    scrollZoom: false,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"]
  };

  // React actualiza el mismo gráfico. Es más estable y evita que el contenedor
  // crezca o quede vacío después de consultar y descargar varias veces.
  Plotly.react(plotElement, traces, layout, plotConfig).then(() => {
    window.requestAnimationFrame(() => Plotly.Plots.resize(plotElement));
  });
}

/**
 * Ráster en teselas Web Mercator. Cada píxel se transforma a lon/lat y se
 * consulta en la malla original. NO se estira una imagen geográfica entre
 * cuatro esquinas ni se aplica interpolación bilineal.
 */
function fogColor(value, maximum) {
  if (!Number.isFinite(value) || value <= 0 || !(maximum > 0)) return [0, 0, 0, 0];
  const norm = Math.pow(Math.min(1, value / maximum), 0.42);
  const stops = [
    [0, [255, 0, 255, 220]], [0.18, [185, 0, 255, 230]],
    [0.38, [255, 0, 100, 240]], [0.62, [255, 80, 0, 248]],
    [0.82, [255, 215, 0, 255]], [1, [255, 255, 255, 255]]
  ];
  for (let k = 1; k < stops.length; k++) {
    if (norm <= stops[k][0]) {
      const fraction = (norm - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]);
      return stops[k - 1][1].map((v, channel) =>
        Math.round(v + fraction * (stops[k][1][channel] - v)));
    }
  }
  return stops[stops.length - 1][1];
}

function mercatorPixelToLatitude(pixelY, worldSize) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * pixelY / worldSize))) * 180 / Math.PI;
}

function makeTileAxisSamples(axis, count, origin, ratio, worldSize, isLatitude) {
  const center = new Int32Array(count), first = new Int32Array(count), last = new Int32Array(count);
  const coordinate = pixel => isLatitude
    ? mercatorPixelToLatitude(pixel, worldSize) : pixel / worldSize * 360 - 180;
  for (let p = 0; p < count; p++) {
    center[p] = nearestAxisIndex(axis, coordinate(origin + (p + 0.5) / ratio));
    // Bordes ligeramente interiores para no incluir la celda contigua cuando
    // la arista coincide exactamente con el borde de un píxel.
    const a = nearestAxisIndex(axis, coordinate(origin + (p + 1e-6) / ratio));
    const b = nearestAxisIndex(axis, coordinate(origin + (p + 1 - 1e-6) / ratio));
    first[p] = a < 0 || b < 0 ? -1 : Math.min(a, b);
    last[p] = a < 0 || b < 0 ? -1 : Math.max(a, b);
  }
  return { center, first, last };
}

function fogPixelValue(summary, xSamples, ySamples, px, py) {
  const i = xSamples.center[px], j = ySamples.center[py];
  const x0 = xSamples.first[px], x1 = xSamples.last[px];
  const y0 = ySamples.first[py], y1 = ySamples.last[py];
  if (i < 0 || j < 0 || x0 < 0 || y0 < 0) return null;
  const { values, geometry } = summary;
  const value = values[j * geometry.width + i];
  if (!Number.isFinite(value) || value <= 0) return null;
  // Máscara conservadora: si un píxel de pantalla abarca alguna celda cero
  // o sin dato, no se colorea. Así un foco pequeño no invade celdas vacías.
  // Los focos menores que un píxel se recuperan al acercar el mapa.
  for (let row = y0; row <= y1; row++) {
    for (let col = x0; col <= x1; col++) {
      if (!(values[row * geometry.width + col] > 0)) return null;
    }
  }
  return value;
}

function paintFogTile(summary, coordinates, tileSize = 256, pixelRatio = 1) {
  const ratio = pixelRatio > 1 ? 2 : 1;
  const width = Math.round(tileSize * ratio), height = width;
  const worldSize = tileSize * Math.pow(2, coordinates.z);
  const xSamples = makeTileAxisSamples(summary.geometry.x, width,
    coordinates.x * tileSize, ratio, worldSize, false);
  const ySamples = makeTileAxisSamples(summary.geometry.y, height,
    coordinates.y * tileSize, ratio, worldSize, true);
  const data = new Uint8ClampedArray(width * height * 4);
  if (!summary.colorTable) {
    summary.colorTable = Array.from({ length: 4096 }, (_, k) => fogColor(k || 1, 4095));
  }
  for (let py = 0; py < height; py++) {
    if (ySamples.center[py] < 0) continue;
    for (let px = 0; px < width; px++) {
      const value = fogPixelValue(summary, xSamples, ySamples, px, py);
      if (value === null) continue; // alfa 0: se conserva exclusivamente el satélite
      const colorIndex = Math.max(1, Math.min(4095, Math.round(value / summary.displayMax * 4095)));
      const color = summary.colorTable[colorIndex], offset = (py * width + px) * 4;
      data[offset] = color[0]; data[offset + 1] = color[1];
      data[offset + 2] = color[2]; data[offset + 3] = color[3];
    }
  }
  return { width, height, data };
}

function removeFogOverlay() {
  if (ncOverlayLayer) { map.removeLayer(ncOverlayLayer); ncOverlayLayer = null; }
  if (ncLegendControl) { map.removeControl(ncLegendControl); ncLegendControl = null; }
}

function drawNetCDFOverlay() {
  if (!state.ncData || state.isLoading) return;
  removeFogOverlay();
  try {
    const variable = getMapVariableName();
    if (!variable) return;
    const nc = state.ncData, summary = getLayerSummary(nc, variable);
    const FogTiles = L.GridLayer.extend({
      createTile(coordinates) {
        const tile = L.DomUtil.create("canvas", "amaru-fog-raster");
        const image = paintFogTile(summary, coordinates, 256, window.devicePixelRatio || 1);
        tile.width = image.width; tile.height = image.height;
        const ctx = tile.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        const pixels = ctx.createImageData(image.width, image.height);
        pixels.data.set(image.data); ctx.putImageData(pixels, 0, 0);
        tile.setAttribute("aria-hidden", "true");
        return tile;
      }
    });
    if (summary.displayMax > 0) {
      ncOverlayLayer = new FogTiles({
        tileSize: 256, opacity: 0.96, noWrap: true,
        bounds: summary.geometry.bounds, zIndex: 200,
        updateWhenIdle: true, updateWhenZooming: false, keepBuffer: 1
      }).addTo(map);
    }
    // Conservar el zoom y el encuadre al cambiar de variable.
    if (lastFittedDataset !== nc) {
      lastFittedDataset = nc;
      map.fitBounds(summary.geometry.bounds, { padding: [32, 32], maxZoom: 12 });
    }
    const period = summary.useSum ? "Suma del período · Wh" : "Promedio del período · " + variable;
    const range = summary.displayMax ? "> 0 — " + formatFogValue(summary.displayMax) : "Sin valores positivos";
    const gradient = Array.from({ length: 9 }, (_, k) => {
      const color = fogColor(Math.max(1e-12, k / 8), 1);
      return "rgb(" + color.slice(0, 3).join(",") + ") " + (k * 12.5) + "%";
    }).join(",");
    ncLegendControl = L.control({ position: "bottomright" });
    ncLegendControl.onAdd = () => {
      const div = L.DomUtil.create("div", "nc-raster-legend");
      div.style.cssText = "background:rgba(15,23,42,.94);color:#e2e8f0;padding:10px 12px;" +
        "border:1px solid #475569;border-radius:10px;font:12px Inter,sans-serif;max-width:250px";
      const title = document.createElement("strong"); title.textContent = period; div.appendChild(title);
      const bar = document.createElement("div");
      bar.style.cssText = "height:12px;margin:8px 0 4px;border-radius:3px;background:linear-gradient(to right," + gradient + ")";
      div.appendChild(bar);
      const labels = document.createElement("div");
      labels.textContent = range + (summary.units ? " " + summary.units : "");
      div.appendChild(labels);
      const note = document.createElement("div");
      note.style.cssText = "font-size:10px;line-height:1.5;margin-top:6px;color:#cbd5e1";
      note.textContent = "Sin color: cero o sin dato. P98: los valores superiores saturan la escala.";
      div.appendChild(note);
      const zoomNote = document.createElement("div");
      zoomNote.style.cssText = "font-size:10px;margin-top:3px;color:#94a3b8";
      zoomNote.textContent = "Acércate para ver celdas pequeñas · Malla exacta v4";
      div.appendChild(zoomNote);
      L.DomEvent.disableClickPropagation(div); L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    ncLegendControl.addTo(map);
    if (state.extractedTimeSeries) drawSelectedGridCell();
    statusText.textContent = "Mapa de celdas exactas · " + variable + " · " + APP_VERSION;
  } catch (error) {
    console.error(error);
    statusText.textContent = "No se puede dibujar la malla: " + error.message;
  }
}

function exportToExcel() {
  if (!state.extractedTimeSeries) {
    alert("Por favor consulta los datos primero.");
    return;
  }

  const ext = state.extractedTimeSeries;
  const meses = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
  ];

  const nombresVariables = Object.keys(ext.extracted);
  if (nombresVariables.length === 0) {
    alert("El archivo NetCDF no contiene variables disponibles para exportar.");
    return;
  }

  // Si el usuario eligió una variable específica, se respeta. Si eligió
  // "Todas", se prioriza Wh porque corresponde al potencial de captación.
  const variableSeleccionada =
    varSelect && varSelect.value !== "all" && ext.extracted[varSelect.value]
      ? varSelect.value
      : nombresVariables.find(nombre => nombre.toLowerCase() === "wh") || nombresVariables[0];

  const datosVariable = ext.extracted[variableSeleccionada];
  const esWh = variableSeleccionada.toLowerCase() === "wh";
  const esLwc = variableSeleccionada.toLowerCase() === "lwc";
  const tituloVariable = esWh
    ? "Potencial de captación de niebla (Wh)"
    : esLwc
      ? "Contenido de agua líquida (LWC)"
      : variableSeleccionada;
  const unidadMensual = esWh
    ? "L/m²/mes"
    : esLwc
      ? "g/kg"
      : (datosVariable.units || "");
  const unidadAnual = esWh ? "L/m²/año" : unidadMensual;

  const valoresMensuales = datosVariable.values.map(valor =>
    typeof valor === "number" && Number.isFinite(valor) ? valor : null
  );
  const valoresValidos = valoresMensuales.filter(valor => valor !== null);
  const valoresPositivos = valoresValidos.filter(valor => valor > 0);

  const suma = valoresValidos.reduce((acumulado, valor) => acumulado + valor, 0);
  const promedio = valoresValidos.length > 0 ? suma / valoresValidos.length : null;
  const resumenAnual = valoresValidos.length ? (esWh ? suma : promedio) : null;
  const maximoMensual = valoresValidos.length > 0 ? Math.max(...valoresValidos) : null;
  const indiceMaximo = maximoMensual === null
    ? -1
    : valoresMensuales.findIndex(valor => valor === maximoMensual);
  const mesMaximo = indiceMaximo >= 0 ? meses[indiceMaximo % 12] : "Sin dato";

  const region = obtenerRegionDesdeNombre(state.activeFilename);
  const anioRepresentativo = obtenerAnioRepresentativo(ext.timeSteps, state.activeFilename);
  const dentroExtension = coordenadaDentroDeExtension(state.lon, state.lat);
  const estadisticas = calcularEstadisticasCapa(variableSeleccionada, esWh);

  const latitudIngresada = redondear(state.lat, 6);
  const longitudIngresada = redondear(state.lon, 6);
  const latitudCelda = redondear(ext.nearestGridY, 12);
  const longitudCelda = redondear(ext.nearestGridX, 12);

  const resumen = [
    ["REPORTE DE CONSULTA ESPACIAL AMARU", "", "", "", "", ""],
    [],
    ["1. IDENTIFICACIÓN Y COORDENADA", "", "", "", "", ""],
    ["Región", region],
    ["Año representativo", anioRepresentativo],
    ["Variable", tituloVariable],
    ["Capa espacial mostrada", esWh ? "Acumulado anual de Wh" : "Promedio anual de LWC"],
    ["Mes de la capa", "No aplica"],
    ["Unidad de la capa", unidadAnual],
    ["Latitud ingresada", latitudIngresada],
    ["Longitud ingresada", longitudIngresada],
    ["Este UTM ingresado", ext.targetX],
    ["Norte UTM ingresado", ext.targetY],
    ["SRC de la coordenada ingresada", state.selectedCrs],
    ["Latitud de la celda original", latitudCelda],
    ["Longitud de la celda original", longitudCelda],
    ["Coordenada dentro de la extensión", dentroExtension ? "Sí" : "No"],
    ["Valor exacto correspondiente a la capa", resumenAnual],
    [],
    ["2. INDICADORES DE LA SERIE MENSUAL EXACTA", "", "", "", "", ""],
    ["Indicador", "Valor", "Unidad"],
    [esWh ? "Suma anual Wh" : "Promedio anual LWC", resumenAnual, unidadAnual],
    ["Promedio mensual", promedio, unidadMensual],
    ["Máximo mensual", maximoMensual, unidadMensual],
    ["Mes del máximo", mesMaximo, ""],
    ["Meses con valor positivo", valoresPositivos.length, "meses"],
    ["Meses con dato válido", valoresValidos.length, "meses"],
    [],
    [
      "La consulta utiliza exclusivamente la celda original más cercana a la coordenada ingresada. " +
      "No se buscan, sustituyen ni interpretan celdas positivas cercanas.",
      "", "", "", "", ""
    ]
  ];

  const serieMensual = [[
    "Mes_número", "Mes", "Fecha", "Valor_exacto", "Unidad", "Estado",
    "Latitud_celda", "Longitud_celda"
  ]];

  valoresMensuales.forEach((valor, indice) => {
    const estado = valor === null ? "Sin dato" : valor > 0 ? "Positivo" : "Cero";
    serieMensual.push([
      indice + 1,
      meses[indice % 12],
      ext.timeSteps[indice] || "",
      valor,
      unidadMensual,
      estado,
      latitudCelda,
      longitudCelda
    ]);
  });

  const estadisticasCapa = [
    ["Indicador", "Valor", "Unidad"],
    ["Celdas válidas", estadisticas.nValidos, "celdas"],
    ["Celdas positivas", estadisticas.nPositivos, "celdas"],
    ["Porcentaje positivo", estadisticas.porcentajePositivo, "%"],
    ["Mínimo positivo", estadisticas.minimoPositivo, unidadAnual],
    ["Percentil 25", estadisticas.p25, unidadAnual],
    ["Mediana", estadisticas.mediana, unidadAnual],
    ["Percentil 75", estadisticas.p75, unidadAnual],
    ["Percentil 90", estadisticas.p90, unidadAnual],
    ["Máximo", estadisticas.maximo, unidadAnual]
  ];

  const metadatos = [
    ["Campo", "Valor"],
    ["Fecha de generación", new Date().toLocaleString("es-CL")],
    ["Región", region],
    ["Año representativo", anioRepresentativo],
    ["Variable", tituloVariable],
    ["Capa mostrada", esWh ? "Acumulado anual de Wh" : "Promedio anual de LWC"],
    ["Mes de la capa", "No aplica"],
    ["Archivo NetCDF regional", state.activeFilename],
    ["SRC ingresado", state.selectedCrs],
    ["Este UTM ingresado", ext.targetX],
    ["Norte UTM ingresado", ext.targetY],
    ["Latitud ingresada", latitudIngresada],
    ["Longitud ingresada", longitudIngresada],
    ["Índice i de la celda original", ext.nearestI],
    ["Índice j de la celda original", ext.nearestJ],
    ["Latitud de la celda original", latitudCelda],
    ["Longitud de la celda original", longitudCelda],
    ["Total de pasos de tiempo", ext.timeSteps.length],
    [
      "Criterio de consulta",
      "La serie mensual y el Excel usan exclusivamente la celda original más cercana a la coordenada ingresada."
    ]
  ];

  const workbook = XLSX.utils.book_new();
  const hojaResumen = XLSX.utils.aoa_to_sheet(resumen);
  const hojaSerie = XLSX.utils.aoa_to_sheet(serieMensual);
  const hojaEstadisticas = XLSX.utils.aoa_to_sheet(estadisticasCapa);
  const hojaMetadatos = XLSX.utils.aoa_to_sheet(metadatos);

  configurarHojaResumen(hojaResumen);
  configurarHojaSerie(hojaSerie, serieMensual.length);
  configurarHojaEstadisticas(hojaEstadisticas, estadisticasCapa.length);
  configurarHojaMetadatos(hojaMetadatos, metadatos.length);

  XLSX.utils.book_append_sheet(workbook, hojaResumen, "Resumen");
  XLSX.utils.book_append_sheet(workbook, hojaSerie, "Serie_mensual");
  XLSX.utils.book_append_sheet(workbook, hojaEstadisticas, "Estadisticas_capa");
  XLSX.utils.book_append_sheet(workbook, hojaMetadatos, "Metadatos");

  const latNombre = Number(state.lat).toFixed(2);
  const lonNombre = Number(state.lon).toFixed(2);
  const nombreArchivo = `AMARU_${nombreSeguro(region)}_Lat${latNombre}_Lon${lonNombre}.xlsx`;

  XLSX.writeFile(workbook, nombreArchivo, { compression: true });
  statusText.textContent = `Excel descargado: ${nombreArchivo}`;
}

function obtenerRegionDesdeNombre(nombreArchivo) {
  if (!nombreArchivo) return "Sin_region";

  const nombres = [
    "Arica", "Tarapaca", "Antofagasta", "Atacama", "Coquimbo",
    "Valparaiso", "OHiggins", "Maule", "Nuble", "Biobio", "Araucania"
  ];
  const nombreNormalizado = nombreArchivo.toLowerCase();
  const coincidencia = nombres.find(nombre =>
    nombreNormalizado.includes(nombre.toLowerCase())
  );

  if (!coincidencia) return "Region";
  const etiquetas = {
    Tarapaca: "Tarapacá",
    Valparaiso: "Valparaíso",
    OHiggins: "O'Higgins",
    Nuble: "Ñuble",
    Biobio: "Biobío",
    Araucania: "Araucanía"
  };
  return etiquetas[coincidencia] || coincidencia;
}

function obtenerAnioRepresentativo(pasosTiempo, nombreArchivo) {
  if (pasosTiempo && pasosTiempo.length > 0) {
    const coincidenciaTiempo = String(pasosTiempo[0]).match(/(19|20)\d{2}/);
    if (coincidenciaTiempo) return Number(coincidenciaTiempo[0]);
  }

  const coincidenciaNombre = String(nombreArchivo || "").match(/(19|20)\d{2}/);
  return coincidenciaNombre ? Number(coincidenciaNombre[0]) : "No especificado";
}

function coordenadaDentroDeExtension(longitud, latitud) {
  try {
    const geometry = getGridGeometry();
    return nearestAxisIndex(geometry.x, longitud) >= 0 && nearestAxisIndex(geometry.y, latitud) >= 0;
  } catch (_) { return false; }
}

function calcularEstadisticasCapa(nombreVariable, usarSuma) {
  // Las estadísticas se calculan sobre la misma capa que se pinta, sin repetir
  // la lectura de los 12 meses ni ordenar millones de ceros al descargar.
  return getLayerSummary(state.ncData, nombreVariable).statistics;
}

function percentil(valoresOrdenados, proporcion) {
  if (!valoresOrdenados || valoresOrdenados.length === 0) return null;
  const posicion = (valoresOrdenados.length - 1) * proporcion;
  const inferior = Math.floor(posicion);
  const superior = Math.ceil(posicion);
  if (inferior === superior) return valoresOrdenados[inferior];
  const peso = posicion - inferior;
  return valoresOrdenados[inferior] * (1 - peso) + valoresOrdenados[superior] * peso;
}

function redondear(valor, decimales) {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  const factor = 10 ** decimales;
  return Math.round((valor + Number.EPSILON) * factor) / factor;
}

function nombreSeguro(texto) {
  return String(texto || "Region")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function estiloTitulo() {
  return {
    font: { bold: true, color: { rgb: "FFFFFF" }, sz: 15 },
    fill: { fgColor: { rgb: "17365D" } },
    alignment: { horizontal: "center", vertical: "center" }
  };
}

function estiloSeccion() {
  return {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { fgColor: { rgb: "2F75B5" } },
    alignment: { horizontal: "left", vertical: "center" }
  };
}

function estiloEncabezado() {
  return {
    font: { bold: true, color: { rgb: "FFFFFF" } },
    fill: { fgColor: { rgb: "4472C4" } },
    alignment: { horizontal: "center", vertical: "center", wrapText: true },
    border: bordeCompleto()
  };
}

function estiloEtiqueta() {
  return {
    font: { bold: true },
    fill: { fgColor: { rgb: "D9EAF7" } },
    alignment: { vertical: "center", wrapText: true },
    border: bordeCompleto()
  };
}

function bordeCompleto() {
  const lado = { style: "thin", color: { rgb: "B7C9DA" } };
  return { top: lado, bottom: lado, left: lado, right: lado };
}

function aplicarEstiloRango(hoja, rango, estilo) {
  const limites = XLSX.utils.decode_range(rango);
  for (let fila = limites.s.r; fila <= limites.e.r; fila++) {
    for (let columna = limites.s.c; columna <= limites.e.c; columna++) {
      const direccion = XLSX.utils.encode_cell({ r: fila, c: columna });
      if (!hoja[direccion]) hoja[direccion] = { t: "s", v: "" };
      hoja[direccion].s = estilo;
    }
  }
}

function aplicarFormatoNumerico(hoja, columnas, filaInicio, filaFin) {
  columnas.forEach(columna => {
    for (let fila = filaInicio; fila <= filaFin; fila++) {
      const celda = hoja[XLSX.utils.encode_cell({ r: fila, c: columna })];
      if (celda && celda.t === "n") celda.z = "0.000000";
    }
  });
}

function configurarHojaResumen(hoja) {
  hoja["!merges"] = [
    XLSX.utils.decode_range("A1:F1"),
    XLSX.utils.decode_range("A3:F3"),
    XLSX.utils.decode_range("A20:F20"),
    XLSX.utils.decode_range("A29:F29")
  ];
  hoja["!cols"] = [
    { wch: 42 }, { wch: 42 }, { wch: 18 }, { wch: 17 }, { wch: 17 }, { wch: 17 }
  ];
  hoja["!rows"] = [{ hpt: 26 }];
  aplicarEstiloRango(hoja, "A1:F1", estiloTitulo());
  aplicarEstiloRango(hoja, "A3:F3", estiloSeccion());
  aplicarEstiloRango(hoja, "A20:F20", estiloSeccion());
  aplicarEstiloRango(hoja, "A21:C21", estiloEncabezado());
  aplicarEstiloRango(hoja, "A4:A18", estiloEtiqueta());
  aplicarEstiloRango(hoja, "A29:F29", {
    fill: { fgColor: { rgb: "E8F1FA" } },
    alignment: { vertical: "center", wrapText: true }
  });
  aplicarFormatoNumerico(hoja, [1], 3, 26);
}

function configurarHojaSerie(hoja, numeroFilas) {
  hoja["!cols"] = [
    { wch: 12 }, { wch: 17 }, { wch: 15 }, { wch: 18 },
    { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 19 }
  ];
  hoja["!autofilter"] = { ref: `A1:H${numeroFilas}` };
  aplicarEstiloRango(hoja, "A1:H1", estiloEncabezado());
  aplicarFormatoNumerico(hoja, [3, 6, 7], 1, numeroFilas - 1);
}

function configurarHojaEstadisticas(hoja, numeroFilas) {
  hoja["!cols"] = [{ wch: 34 }, { wch: 20 }, { wch: 18 }];
  hoja["!autofilter"] = { ref: `A1:C${numeroFilas}` };
  aplicarEstiloRango(hoja, "A1:C1", estiloEncabezado());
  aplicarFormatoNumerico(hoja, [1], 1, numeroFilas - 1);
}

function configurarHojaMetadatos(hoja, numeroFilas) {
  hoja["!cols"] = [{ wch: 38 }, { wch: 85 }];
  aplicarEstiloRango(hoja, "A1:B1", estiloEncabezado());
  aplicarEstiloRango(hoja, `A2:A${numeroFilas}`, estiloEtiqueta());
  aplicarFormatoNumerico(hoja, [1], 1, numeroFilas - 1);
}
