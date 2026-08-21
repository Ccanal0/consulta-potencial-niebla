#!/usr/bin/env python3
"""
NetCDF Spatial Point Time-Series Extractor & Excel Exporter
Extracts time series at (Easting, Northing) from NetCDF files to Excel (.xlsx).
"""

import sys
import os
import argparse
import xarray as xr
import numpy as np
import pandas as pd
from pyproj import Transformer

def extract_netcdf_point(nc_path, easting, northing, crs="EPSG:32719", output_excel=None):
    """
    Extract time series from NetCDF at specified Easting/Northing coordinates.
    """
    print(f"Opening NetCDF: {nc_path}")
    ds = xr.open_dataset(nc_path)

    # Detect coordinate names
    x_name = next((c for c in ['x', 'lon', 'longitude', 'easting'] if c in ds.coords or c in ds.dims), None)
    y_name = next((c for c in ['y', 'lat', 'latitude', 'northing'] if c in ds.coords or c in ds.dims), None)

    if not x_name or not y_name:
        raise ValueError(f"Could not identify x/y spatial coordinates in {nc_path}")

    # Determine projection of NetCDF
    nc_x = ds[x_name].values
    nc_y = ds[y_name].values

    target_x = easting
    target_y = northing

    # Transform input coordinates if NetCDF is in lat/lon but input is UTM (or vice versa)
    is_nc_latlon = (np.min(nc_x) >= -180 and np.max(nc_x) <= 180 and np.min(nc_y) >= -90 and np.max(nc_y) <= 90)
    
    if is_nc_latlon and crs != "EPSG:4326":
        print(f"Transforming input {crs} (E: {easting}, N: {northing}) to EPSG:4326 Lat/Lon...")
        transformer = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)
        target_x, target_y = transformer.transform(easting, northing)
        print(f"-> Converted to Lon: {target_x:.6f}, Lat: {target_y:.6f}")

    # Nearest neighbor selection
    point_ds = ds.sel({x_name: target_x, y_name: target_y}, method="nearest")

    # Build DataFrame
    df = pd.DataFrame()

    time_name = next((c for c in ['time', 'datetime', 'date'] if c in point_ds.coords or c in point_ds.dims), None)

    if time_name:
        df["Time"] = point_ds[time_name].values

    for var in point_ds.data_vars:
        if point_ds[var].ndim <= 1:
            df[var] = point_ds[var].values

    # Output path
    if not output_excel:
        base = os.path.splitext(os.path.basename(nc_path))[0]
        output_excel = f"{base}_extract_X{int(easting)}_Y{int(northing)}.xlsx"

    # Export to Excel with metadata
    with pd.ExcelWriter(output_excel, engine="openpyxl") as writer:
        df.to_excel(writer, sheet_name="Time Series Data", index=False)

        meta_df = pd.DataFrame([
            {"Metadata": "Source File", "Value": os.path.basename(nc_path)},
            {"Metadata": "Input Easting (X)", "Value": easting},
            {"Metadata": "Input Northing (Y)", "Value": northing},
            {"Metadata": "Input CRS", "Value": crs},
            {"Metadata": "Resolved NetCDF X", "Value": float(point_ds[x_name].values)},
            {"Metadata": "Resolved NetCDF Y", "Value": float(point_ds[y_name].values)},
        ])
        meta_df.to_excel(writer, sheet_name="Spatial Metadata", index=False)

    print(f"SUCCESS: Extracted data saved to Excel -> {output_excel}")
    return output_excel

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Extract NetCDF time series by Easting/Northing to Excel")
    parser.add_argument("nc_file", help="Path to NetCDF file")
    parser.add_argument("--easting", "-x", type=float, required=True, help="Easting X coordinate (meters)")
    parser.add_argument("--northing", "-y", type=float, required=True, help="Northing Y coordinate (meters)")
    parser.add_argument("--crs", type=str, default="EPSG:32719", help="EPSG Projection code (default: EPSG:32719 UTM 19S)")
    parser.add_argument("--output", "-o", type=str, default=None, help="Output Excel filename")

    args = parser.parse_args()
    extract_netcdf_point(args.nc_file, args.easting, args.northing, args.crs, args.output)
