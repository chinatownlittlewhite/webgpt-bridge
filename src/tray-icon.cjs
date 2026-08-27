// Electron NativeImage supports PNG/JPEG on every desktop platform and ICO by
// path on Windows. Keep tray rasters inline so they are always available even
// before the BrowserWindow or packaged resources are initialized.
const MAC_TRAY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAOklEQVR42mNgGAVDBvyHYgZGCg2BAyZqOY2RGNuwqEeXZ2QkQjNRDmHCYwgjgTBkJMqpVInKUTDIAQCYkwoGOvpq5AAAAABJRU5ErkJggg==";
const WINDOWS_TRAY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAyklEQVR42mNgGOmAEZ+kjIrSf2pZ9OTOPUaiHUBNiwk5hImelmMzn4melmOzh2mgEyETvX2Pbt/gCYER6wAWWltgtakHzj7mV0LfEEC2HBuf5BC4fvkyTjlNXV3apgF8lhPje4ocQC3LsaUBRkIFET7Lk+/vJMpB2CyGVUwspPoaOa6JCWZcluONAmIsp8TnZCVCWlhOcUFErCUkhwC6b8nN4xSFAC0tHa0NB6cDcLXbad08H1xRQK9QQLaHidguFK16RgPeNxxwAADlr1BHzfcTjQAAAABJRU5ErkJggg==";

function trayIconDataUrl(platform) {
  return platform === "darwin" ? MAC_TRAY_PNG : WINDOWS_TRAY_PNG;
}

module.exports = { trayIconDataUrl };
