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
let selectedCellLayer = null;
let coordinateInputTimer = null;

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
  map = L.map("map", { center: [-30.0, -71.0], zoom: 6 });

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
      attribution: "Labels © Esri"
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
      attribution: "Labels © Esri"
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
    queryAndPlot();
  });

  btnExportExcel.addEventListener("click", () => {
    exportToExcel();
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
  if (!state.ncData) {
    statusText.textContent = "Esperando la carga del archivo NetCDF...";
    return;
  }

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

  // Consulta estricta: se usa exclusivamente la celda original de la malla
  // más cercana a la coordenada ingresada. Si esa celda contiene cero o no
  // tiene niebla, se informa ese resultado sin buscar celdas positivas vecinas.
  const activeJ = nearestJ;
  const activeI = nearestI;
  const snappedToFog = false;
  const snapDistanceKm = 0;

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
  const selectedCellInfo = drawSelectedGridCell();
  const valueText = selectedCellInfo
    ? ` · ${selectedCellInfo.variable}: ${selectedCellInfo.formattedValue}`
    : "";
  statusText.textContent = `Consulta actualizada: Lat ${state.lat.toFixed(4)}, Lon ${state.lon.toFixed(4)}${valueText}`;
}

function getMapVariableName() {
  if (!state.ncData || !state.ncData.variables) return null;
  const varNames = Object.keys(state.ncData.variables).filter(
    name => !["x", "y", "lat", "lon", "time", "datetime"].includes(name.toLowerCase())
  );
  if (!varNames.length) return null;

  const selectedVar = varSelect ? varSelect.value : "all";
  return selectedVar !== "all" && varNames.includes(selectedVar)
    ? selectedVar
    : varNames[0];
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

  if (selectedCellLayer) {
    map.removeLayer(selectedCellLayer);
    selectedCellLayer = null;
  }

  const ext = state.extractedTimeSeries;
  const xEdges = getGridCellEdges(state.ncData.x, ext.activeI);
  const yEdges = getGridCellEdges(state.ncData.y, ext.activeJ);
  const variable = getMapVariableName();
  const variableData = variable ? ext.extracted[variable] : null;
  if (!xEdges || !yEdges || !variableData) return null;

  const validValues = variableData.values.filter(
    value => typeof value === "number" && Number.isFinite(value)
  );
  const annualValue = validValues.reduce((sum, value) => sum + value, 0);
  const hasPositiveValue = annualValue > 0;
  const formattedValue = Number.isFinite(annualValue)
    ? annualValue.toLocaleString("es-CL", { maximumFractionDigits: 4 })
    : "sin dato";
  const units = variableData.units ? ` ${variableData.units}` : "";
  const outlineColor = hasPositiveValue ? "#ffffff" : "#ff3b30";

  selectedCellLayer = L.rectangle(
    [[yEdges[0], xEdges[0]], [yEdges[1], xEdges[1]]],
    {
      pane: "selectedCellPane",
      color: outlineColor,
      weight: 3,
      opacity: 1,
      dashArray: hasPositiveValue ? null : "6 4",
      fillColor: hasPositiveValue ? "#ffffff" : "#0f172a",
      fillOpacity: hasPositiveValue ? 0.04 : 0.72,
      interactive: false
    }
  ).addTo(map);

  marker.setIcon(createMapMarkerIcon(hasPositiveValue ? "#22c55e" : "#ef4444", hasPositiveValue ? "✓" : "0"));
  marker.unbindTooltip();
  marker.bindTooltip(
    `<b>Celda exacta consultada</b><br>${variable} Σ anual: ${formattedValue}${units}<br>` +
    `i=${ext.activeI}, j=${ext.activeJ}`,
    { direction: "top", offset: [0, -14], className: "amaru-cell-tooltip", opacity: 1 }
  );

  return { variable, annualValue, formattedValue: `${formattedValue}${units}` };
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
        `Valor: %{y:.4f}${vData.units ? " " + vData.units : ""}<extra></extra>`
    });
    colorIdx++;
  });

  const selectedValues = selectedNames.flatMap(varName => ext.extracted[varName].values);
  const hasAnyValidValue = selectedValues.some(v => typeof v === "number" && Number.isFinite(v));
  const hasAnyPositiveValue = selectedValues.some(v => typeof v === "number" && Number.isFinite(v) && v > 0);

  const emptyMessage = !hasAnyValidValue
    ? "No hay datos legibles en la celda original seleccionada"
    : !hasAnyPositiveValue
      ? "Celda original válida: valor 0 durante todos los meses (sin niebla registrada)"
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
    tickformat: ".3~f",
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

  // La misma variable gobierna el ráster, la leyenda y el valor mostrado en
  // la celda seleccionada, evitando mensajes visuales contradictorios.
  const varToPlot = getMapVariableName();
  if (!varToPlot) return;

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

  // Calcular valor máximo real y percentil 98 para la escala visual.
  // El P98 evita que una sola celda extrema vuelva invisible el resto de la niebla.
  let maxVal = 0;
  const positiveDisplayValues = [];
  for (let k = 0; k < grid2d.length; k++) {
    if (grid2d[k] > maxVal) maxVal = grid2d[k];
    if (grid2d[k] > 0 && Number.isFinite(grid2d[k])) positiveDisplayValues.push(grid2d[k]);
  }

  if (maxVal === 0) {
    statusText.textContent = `Cargado ${state.activeFilename} (sin datos no-cero en el área)`;
    return;
  }

  positiveDisplayValues.sort((a, b) => a - b);
  const p98Index = Math.max(0, Math.floor((positiveDisplayValues.length - 1) * 0.98));
  const displayMax = positiveDisplayValues[p98Index] || maxVal;

  // Rampa cálida de alto contraste. Se evita deliberadamente el azul porque
  // se confunde con el mar, sombras y vegetación del fondo satelital.
  // Los valores nulos y cero permanecen completamente transparentes.
  function fogColormap(norm) {
    if (norm <= 0) return [0, 0, 0, 0]; // transparente
    const stops = [
      [0.001, [255, 0,   255, 190]],
      [0.18,  [185, 0,   255, 215]],
      [0.38,  [255, 0,   100, 235]],
      [0.62,  [255, 80,  0,   245]],
      [0.82,  [255, 215, 0,   252]],
      [1.00,  [255, 255, 255, 255]]
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
      const rawNorm = Math.min(1, grid2d[rowBase + i] / displayMax);
      // Corrección gamma: expande los valores bajos y medios para hacerlos visibles.
      const norm = rawNorm > 0 ? Math.pow(rawNorm, 0.42) : 0;
      const [r, g, b, a] = fogColormap(norm);
      const px = (canvasBase + i) * 4;
      imgData.data[px]     = r;
      imgData.data[px + 1] = g;
      imgData.data[px + 2] = b;
      imgData.data[px + 3] = a;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Las coordenadas NetCDF representan centros de celdas. Leaflet necesita
  // los bordes externos del ráster; usar los centros como límites desplazaba
  // visualmente la capa aproximadamente media celda.
  const lonExtent = getGridExtentEdges(xArr);
  const latExtent = getGridExtentEdges(yArr);
  if (!lonExtent || !latExtent) return;
  const [minLon, maxLon] = lonExtent;
  const [minLat, maxLat] = latExtent;

  // Agregar overlay al mapa
  const imageUrl = canvas.toDataURL("image/png");
  ncOverlayLayer = L.imageOverlay(imageUrl, [[minLat, minLon], [maxLat, maxLon]], {
    opacity: 0.96,
    interactive: false,
    zIndex: 200,
    className: "amaru-fog-raster"
  }).addTo(map);

  // Reponer el contorno por encima del nuevo ráster cuando cambia la variable.
  if (state.extractedTimeSeries) drawSelectedGridCell();

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
        border: 1px solid rgba(255,45,149,0.55);
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
            rgba(255,0,255,0.75),
            rgb(185,0,255),
            rgb(255,0,100),
            rgb(255,80,0),
            rgb(255,215,0),
            rgb(255,255,255)
          );
          margin-bottom:4px;
        "></div>
        <div style="display:flex;justify-content:space-between;font-size:10px;">
          <span>0</span>
          <span>${displayMax.toFixed(2)}</span>
        </div>
        <div style="margin-top:5px;font-size:10px;color:#94a3b8;">Fucsia: bajo · amarillo/blanco: alto</div>
        <div style="margin-top:2px;font-size:10px;color:#64748b;">Σ anual · escala visual P98</div>
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
  const resumenAnual = esWh ? suma : promedio;
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
  const x = state.ncData && state.ncData.x;
  const y = state.ncData && state.ncData.y;
  if (!x || !y || x.length === 0 || y.length === 0) return false;

  let minX = x[0];
  let maxX = x[0];
  let minY = y[0];
  let maxY = y[0];

  for (let i = 1; i < x.length; i++) {
    if (x[i] < minX) minX = x[i];
    if (x[i] > maxX) maxX = x[i];
  }
  for (let j = 1; j < y.length; j++) {
    if (y[j] < minY) minY = y[j];
    if (y[j] > maxY) maxY = y[j];
  }

  return longitud >= minX && longitud <= maxX && latitud >= minY && latitud <= maxY;
}

function calcularEstadisticasCapa(nombreVariable, usarSuma) {
  const resultadoVacio = {
    nValidos: 0,
    nPositivos: 0,
    porcentajePositivo: 0,
    minimoPositivo: null,
    p25: null,
    mediana: null,
    p75: null,
    p90: null,
    maximo: null
  };

  const variable = state.ncData && state.ncData.variables[nombreVariable];
  const data = variable && variable.data;
  const x = state.ncData && state.ncData.x;
  const y = state.ncData && state.ncData.y;
  if (!data || !x || !y || x.length === 0 || y.length === 0) return resultadoVacio;

  const numeroCeldas = x.length * y.length;
  const esTresDimensiones = variable.dimensions && variable.dimensions.length === 3;
  const numeroTiempos = esTresDimensiones
    ? Math.max(1, Math.floor(data.length / numeroCeldas))
    : 1;
  const valoresCapa = [];

  for (let celda = 0; celda < numeroCeldas; celda++) {
    let acumulado = 0;
    let validosCelda = 0;

    for (let t = 0; t < numeroTiempos; t++) {
      const indice = esTresDimensiones ? t * numeroCeldas + celda : celda;
      const valor = data[indice];
      if (typeof valor === "number" && Number.isFinite(valor) && valor <= 1e30) {
        acumulado += valor;
        validosCelda++;
      }
    }

    if (validosCelda > 0) {
      valoresCapa.push(usarSuma ? acumulado : acumulado / validosCelda);
    }
  }

  if (valoresCapa.length === 0) return resultadoVacio;

  valoresCapa.sort((a, b) => a - b);
  const positivos = valoresCapa.filter(valor => valor > 0);
  return {
    nValidos: valoresCapa.length,
    nPositivos: positivos.length,
    porcentajePositivo: redondear((positivos.length / valoresCapa.length) * 100, 6),
    minimoPositivo: positivos.length > 0 ? positivos[0] : null,
    p25: percentil(valoresCapa, 0.25),
    mediana: percentil(valoresCapa, 0.50),
    p75: percentil(valoresCapa, 0.75),
    p90: percentil(valoresCapa, 0.90),
    maximo: valoresCapa[valoresCapa.length - 1]
  };
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
