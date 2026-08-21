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

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  setupEventListeners();
  initH5Wasm();
  await loadCatalogAndIndex();
});

/**
 * Inicializar Motor WebAssembly HDF5 (h5wasm)
 */
async function initH5Wasm() {
  if (typeof h5wasm !== "undefined" && h5wasm.ready) {
    try {
      await h5wasm.ready;
      state.h5wasmReady = true;
      console.log("Motor WebAssembly HDF5 (h5wasm) inicializado.");
    } catch (e) {
      console.warn("Error al inicializar h5wasm:", e);
    }
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

  varSelect.addEventListener("change", () => { renderPlot(); });
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
  if (state.activeFilename === filename && state.ncData) {
    queryAndPlot();
    return;
  }

  statusText.textContent = `Cargando ${filename}...`;

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
  if (typeof h5wasm !== "undefined") {
    try {
      if (!state.h5wasmReady && h5wasm.ready) await h5wasm.ready;

      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      h5wasm.fs.writeFile(safeName, new Uint8Array(arrayBuffer));

      const file = new h5wasm.File(safeName, "r");
      const vars = {};
      let xArr = null, yArr = null, timeArr = null;

      function inspectGroup(group) {
        for (const key of group.keys()) {
          const item = group.get(key);
          if (item instanceof h5wasm.Dataset) {
            const data = item.value;
            vars[key] = {
              name: key,
              dimensions: item.shape,
              data: data,
              attributes: {}
            };

            const kLower = key.toLowerCase();
            if (["x", "lon", "longitude", "easting"].includes(kLower)) xArr = Array.from(data);
            if (["y", "lat", "latitude", "northing"].includes(kLower)) yArr = Array.from(data);
            if (["time", "datetime", "date"].includes(kLower)) timeArr = Array.from(data);
          } else if (item instanceof h5wasm.Group) {
            inspectGroup(item);
          }
        }
      }

      inspectGroup(file);
      file.close();

      if (xArr && yArr) {
        return { dimensions: {}, variables: vars, x: xArr, y: yArr, time: timeArr };
      }
    } catch (e) {
      console.warn("Fallback de h5wasm a netcdfjs:", e);
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

  const isNcLatLon = Math.max(...xArr) <= 180 && Math.min(...xArr) >= -180;
  const queryX = isNcLatLon ? state.lon : targetX;
  const queryY = isNcLatLon ? state.lat : targetY;

  for (let i = 0; i < xArr.length; i++) {
    if (Math.abs(xArr[i] - queryX) < Math.abs(xArr[nearestI] - queryX)) nearestI = i;
  }

  for (let j = 0; j < yArr.length; j++) {
    if (Math.abs(yArr[j] - queryY) < Math.abs(yArr[nearestJ] - queryY)) nearestJ = j;
  }

  const nearestGridX = xArr[nearestI];
  const nearestGridY = yArr[nearestJ];
  const timeSteps = state.ncData.time || Array.from({ length: 12 }, (_, i) => `Mes ${i + 1}`);

  const extracted = {};
  const numY = yArr.length;
  const numX = xArr.length;

  Object.keys(state.ncData.variables).forEach((varName) => {
    if (["x", "y", "lat", "lon", "time", "datetime"].includes(varName.toLowerCase())) return;

    const vObj = state.ncData.variables[varName];
    const data = vObj.data;
    const values = [];

    for (let t = 0; t < timeSteps.length; t++) {
      let val = null;
      if (data) {
        if (vObj.dimensions && vObj.dimensions.length === 3) {
          const idx = t * (numY * numX) + nearestJ * numX + nearestI;
          const raw = data[idx];
          // Keep 0 as a valid value; only discard NaN or fill values (>1e30)
          if (raw !== undefined && !isNaN(raw) && raw <= 1e30) val = raw;
        } else if (vObj.dimensions && vObj.dimensions.length === 2) {
          const idx = nearestJ * numX + nearestI;
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
    targetX, targetY, nearestI, nearestJ, nearestGridX, nearestGridY, timeSteps, extracted
  };

  updateMetadataUI();
  renderPlot();
}

function updateMetadataUI() {
  metaFileName.textContent = state.activeFilename || "-";
  metaLatLon.textContent = `${state.lat.toFixed(4)}°, ${state.lon.toFixed(4)}°`;

  if (state.extractedTimeSeries) {
    const ext = state.extractedTimeSeries;
    metaGrid.textContent = `(i: ${ext.nearestI}, j: ${ext.nearestJ})`;
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

  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(15, 23, 42, 0.6)",
    font: { color: "#94a3b8", family: "Inter, sans-serif" },
    title: {
      text: `Perfil Extraído: ${state.activeFilename} (Este: ${ext.targetX.toLocaleString()}, Norte: ${ext.targetY.toLocaleString()})`,
      font: { color: "#f8fafc", size: 13 }
    },
    xaxis: { title: "Tiempo / Fecha", gridcolor: "rgba(255,255,255,0.05)" },
    yaxis: { title: "Valor de Variable", gridcolor: "rgba(255,255,255,0.05)", rangemode: "tozero" },
    margin: { l: 60, r: 30, t: 50, b: 50 },
    legend: { orientation: "h", y: 1.15 },
    annotations
  };

  Plotly.newPlot("plot-container", traces, layout, { responsive: true, displaylogo: false });
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
