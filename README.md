# NetCDF Spatial Explorer (GitHub Pages Ready)

An interactive, pure-client web application for exploring NetCDF spatial datasets, extracting time series by **Easting (X)** and **Northing (Y)** coordinates, plotting with **Plotly**, and exporting to **Excel (.xlsx)**.

---

## 🌟 Key Features

1. **Easting & Northing Coordinate Extraction**:
   - Input UTM Easting (X) & Northing (Y) or geographic Lat/Lon.
   - Automatic projection conversion via Proj4js (UTM Zone 19S / EPSG:32719, Zone 18S / EPSG:32718, WGS84).
2. **Interactive Map (Leaflet)**:
   - Click anywhere on the map to automatically populate Easting and Northing.
   - Draggable spatial marker synchronized with input fields.
   - Visual spatial bounding box overlay for dataset bounds.
3. **Interactive Time Series Charting (Plotly.js)**:
   - Multi-variable time series plotting with hover tooltips, zoom, and variable selector.
4. **Excel Export (.xlsx)**:
   - Downloads a formatted Excel workbook containing extracted values and metadata via SheetJS.
5. **100% Client-Side / GitHub Pages Ready**:
   - Zero backend required! Runs fully inside any web browser.

---

## 🚀 How to Publish on GitHub Pages

1. Push this repository or directory to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Deploy NetCDF Spatial Explorer"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
   git push -u origin main
   ```
2. On GitHub, navigate to **Settings** > **Pages**.
3. Under **Build and deployment** > **Source**, select **Deploy from a branch**.
4. Choose `main` branch and `/ (root)` folder, then click **Save**.
5. Your app will be live at `https://YOUR_USERNAME.github.io/YOUR_REPOSITORY/`!

---

## 💻 Local Preview

To test locally:
```bash
python3 -m http.server 8000
```
Open `http://localhost:8000` in your browser.
