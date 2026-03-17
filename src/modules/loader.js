/**
 * loader.js — PDF Loading & Rendering
 * Uses PDF.js (pdfjs-dist) to load and render PDF pages as Three.js CanvasTextures.
 * Maintains an LRU cache of up to 20 rendered textures.
 *
 * Spread detection: PDFs where pages after the cover are pre-composed spreads
 * (landscape pages ≈ 2× the aspect ratio of page 1) are automatically split into
 * virtual half-page entries so the rest of the system sees only portrait-shaped pages.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';

// PDF.js worker URL — overridable via PageFlipOpen.setPdfWorkerSrc()
// Default tries ESM import.meta.url; IIFE builds should call setPdfWorkerSrc() manually.
let _workerSrcSet = false;

export function setPdfWorkerSrc(src) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = src;
  _workerSrcSet = true;
}

function ensureWorkerSrc() {
  if (_workerSrcSet || pdfjsLib.GlobalWorkerOptions.workerSrc) return;
  try {
    // Resolve pdf.worker.mjs relative to this bundle file.
    // build.js copies the worker to dist/ next to pageflipopen.js,
    // so new URL('./pdf.worker.mjs', import.meta.url) always lands in the right place.
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      './pdf.worker.mjs',
      import.meta.url
    ).toString();
  } catch {
    console.warn(
      'PageFlipOpen: Could not auto-resolve PDF.js worker URL. ' +
      'Call PageFlipOpen.setPdfWorkerSrc(url) before instantiation.'
    );
  }
}

const CACHE_MAX = 20;
// Render at device-pixel density by default (dims.scale × dpr from PageFlipOpen).
// A floor of 1.5 guards against tiny containers without inflating texture size.
const MIN_RENDER_SCALE = 1.5;

// A PDF page whose width/height ratio is ≥ this multiple of the reference page's
// aspect ratio is treated as a pre-composed two-page spread.
const SPREAD_ASPECT_THRESHOLD = 1.5;

export class Loader {
  constructor() {
    this._pdf = null;
    this._cache = new Map();     // virtualPageNum → CanvasTexture
    this._lruOrder = [];          // virtualPageNum, front = most recently used
    this._pending = new Map();    // virtualPageNum → Promise<CanvasTexture>
    this._pageDimensions = null;  // { width, height } at scale 1 (single-page reference)
    this._renderScale = MIN_RENDER_SCALE;
    // Virtual page map: index = virtualPageNum-1
    // Each entry: { pdfPage: number, side: 'full'|'left'|'right' }
    this._pageMap = [];
  }

  /**
   * Set the scale at which PDF pages are rasterised.
   * Should be called after layout is known: displayScale × devicePixelRatio.
   * If the scale changes significantly the cache is cleared so pages re-render
   * at the new quality.
   */
  setRenderScale(scale) {
    const next = Math.max(scale, MIN_RENDER_SCALE);
    if (Math.abs(next - this._renderScale) > 0.25) {
      // Quality changed enough to be noticeable — evict stale textures
      for (const texture of this._cache.values()) texture.dispose();
      this._cache.clear();
      this._lruOrder = [];
    }
    this._renderScale = next;
  }

  async load(source) {
    ensureWorkerSrc();
    const loadingTask = pdfjsLib.getDocument({ url: source });
    this._pdf = await loadingTask.promise;

    // Page 1 establishes the reference aspect ratio and dimensions.
    const refPdfPage = await this._pdf.getPage(1);
    const refVp = refPdfPage.getViewport({ scale: 1 });
    this._pageDimensions = { width: refVp.width, height: refVp.height };
    const refAspect = refVp.width / refVp.height;

    // Scan all pages to build the virtual page map.
    // getPage() + getViewport() is metadata-only — fast for any PDF size.
    this._pageMap = [];
    for (let i = 1; i <= this._pdf.numPages; i++) {
      const pdfPage = await this._pdf.getPage(i);
      const vp = pdfPage.getViewport({ scale: 1 });
      const aspect = vp.width / vp.height;

      if (aspect >= refAspect * SPREAD_ASPECT_THRESHOLD) {
        // Pre-composed spread: present as two portrait virtual pages
        this._pageMap.push({ pdfPage: i, side: 'left' });
        this._pageMap.push({ pdfPage: i, side: 'right' });
      } else {
        this._pageMap.push({ pdfPage: i, side: 'full' });
      }
    }

    return {
      totalPages: this._pageMap.length,
      pageDimensions: this._pageDimensions,
    };
  }

  /**
   * Returns a Promise<CanvasTexture> for the given virtual page number.
   * Returns from cache if available.
   */
  async getTexture(virtualPageNum) {
    if (this._cache.has(virtualPageNum)) {
      this._touchLRU(virtualPageNum);
      return this._cache.get(virtualPageNum);
    }

    // Coalesce concurrent requests for the same page
    if (this._pending.has(virtualPageNum)) {
      return this._pending.get(virtualPageNum);
    }

    const promise = this._renderVirtualPage(virtualPageNum);
    this._pending.set(virtualPageNum, promise);

    try {
      const texture = await promise;
      this._pending.delete(virtualPageNum);
      this._storeInCache(virtualPageNum, texture);
      return texture;
    } catch (err) {
      this._pending.delete(virtualPageNum);
      throw err;
    }
  }

  async _renderVirtualPage(virtualPageNum) {
    const entry = this._pageMap[virtualPageNum - 1];
    if (!entry) throw new Error(`Virtual page ${virtualPageNum} out of range`);
    if (entry.side === 'full') {
      return this._renderPage(entry.pdfPage);
    }
    return this._renderSpreadHalf(entry.pdfPage, entry.side);
  }

  async _renderPage(pdfPageNum) {
    if (!this._pdf) throw new Error('PDF not loaded');

    const page = await this._pdf.getPage(pdfPageNum);
    const viewport = page.getViewport({ scale: this._renderScale });

    // Normalize to page 1's aspect ratio so the geometry is always filled correctly.
    // Pages with a different aspect ratio are centred on a white padded canvas.
    const targetAspect = this._pageDimensions.width / this._pageDimensions.height;
    const pageAspect = viewport.width / viewport.height;
    let canvasW = Math.round(viewport.width);
    let canvasH = Math.round(viewport.height);
    let tx = 0, ty = 0;
    if (Math.abs(pageAspect - targetAspect) > 0.01) {
      if (pageAspect > targetAspect) {
        // Page is wider than target — pad height
        canvasH = Math.round(viewport.width / targetAspect);
        ty = (canvasH - viewport.height) / 2;
      } else {
        // Page is taller than target — pad width
        canvasW = Math.round(viewport.height * targetAspect);
        tx = (canvasW - viewport.width) / 2;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);
    await page.render({ canvasContext: ctx, viewport, transform: [1, 0, 0, 1, tx, ty] }).promise;

    return this._makeTexture(canvas);
  }

  async _renderSpreadHalf(pdfPageNum, side) {
    if (!this._pdf) throw new Error('PDF not loaded');

    const page = await this._pdf.getPage(pdfPageNum);
    const viewport = page.getViewport({ scale: this._renderScale });

    // Render the full spread to an off-screen canvas
    const spreadW = Math.round(viewport.width);
    const spreadH = Math.round(viewport.height);
    const spreadCanvas = document.createElement('canvas');
    spreadCanvas.width = spreadW;
    spreadCanvas.height = spreadH;
    const spreadCtx = spreadCanvas.getContext('2d');
    spreadCtx.fillStyle = '#ffffff';
    spreadCtx.fillRect(0, 0, spreadW, spreadH);
    await page.render({ canvasContext: spreadCtx, viewport }).promise;

    // Crop to the requested half
    const halfW = spreadW / 2;
    const srcX = side === 'left' ? 0 : halfW;

    // Normalize the cropped half to page 1's aspect ratio
    const targetAspect = this._pageDimensions.width / this._pageDimensions.height;
    const halfAspect = halfW / spreadH;
    let canvasW = Math.round(halfW);
    let canvasH = spreadH;
    let dx = 0, dy = 0;
    if (Math.abs(halfAspect - targetAspect) > 0.01) {
      if (halfAspect > targetAspect) {
        canvasH = Math.round(halfW / targetAspect);
        dy = Math.round((canvasH - spreadH) / 2);
      } else {
        canvasW = Math.round(spreadH * targetAspect);
        dx = Math.round((canvasW - halfW) / 2);
      }
    }

    const outCanvas = document.createElement('canvas');
    outCanvas.width = canvasW;
    outCanvas.height = canvasH;
    const outCtx = outCanvas.getContext('2d');
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, canvasW, canvasH);
    outCtx.drawImage(spreadCanvas, srcX, 0, halfW, spreadH, dx, dy, halfW, spreadH);

    return this._makeTexture(outCanvas);
  }

  _makeTexture(canvas) {
    const texture = new CanvasTexture(canvas);
    // Mipmaps blur crisp text when downsampled — disable them.
    // LinearFilter + SRGBColorSpace gives sharp, colour-accurate output.
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.colorSpace = SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  _storeInCache(pageNum, texture) {
    if (this._cache.size >= CACHE_MAX) {
      this._evictLRU();
    }
    this._cache.set(pageNum, texture);
    this._lruOrder.push(pageNum);
  }

  _touchLRU(pageNum) {
    const idx = this._lruOrder.indexOf(pageNum);
    if (idx !== -1) {
      this._lruOrder.splice(idx, 1);
    }
    this._lruOrder.push(pageNum);
  }

  _evictLRU() {
    const oldest = this._lruOrder.shift();
    if (oldest !== undefined && this._cache.has(oldest)) {
      const texture = this._cache.get(oldest);
      texture.dispose();
      this._cache.delete(oldest);
    }
  }

  /**
   * Prefetch adjacent virtual pages relative to currentPage.
   * Prefetches current spread ± 2 pages.
   */
  prefetch(centerPage, totalPages) {
    const pages = [];
    for (let offset = -2; offset <= 2; offset++) {
      const p = centerPage + offset;
      if (p >= 1 && p <= totalPages) {
        pages.push(p);
      }
    }
    for (const p of pages) {
      if (!this._cache.has(p) && !this._pending.has(p)) {
        this.getTexture(p).catch(() => {}); // silent prefetch
      }
    }
  }

  destroy() {
    for (const texture of this._cache.values()) {
      texture.dispose();
    }
    this._cache.clear();
    this._lruOrder = [];
    this._pending.clear();
    if (this._pdf) {
      this._pdf.destroy();
      this._pdf = null;
    }
    this._pageMap = [];
  }
}
