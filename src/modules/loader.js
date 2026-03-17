/**
 * loader.js — PDF Loading & Rendering
 * Uses PDF.js (pdfjs-dist) to load and render PDF pages as Three.js CanvasTextures.
 * Maintains an LRU cache of up to 20 rendered textures.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { CanvasTexture } from 'three';

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
const MIN_DPR = 2;

export class Loader {
  constructor() {
    this._pdf = null;
    this._cache = new Map();     // pageNum → CanvasTexture
    this._lruOrder = [];          // pageNum, front = most recently used
    this._pending = new Map();    // pageNum → Promise<CanvasTexture>
    this._pageDimensions = null;  // { width, height } at scale 1
  }

  async load(source) {
    ensureWorkerSrc();
    const loadingTask = pdfjsLib.getDocument({ url: source });
    this._pdf = await loadingTask.promise;

    // Get page dimensions from page 1
    const page = await this._pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    this._pageDimensions = { width: viewport.width, height: viewport.height };

    return {
      totalPages: this._pdf.numPages,
      pageDimensions: this._pageDimensions,
    };
  }

  getPageDimensions() {
    return this._pageDimensions;
  }

  getTotalPages() {
    return this._pdf ? this._pdf.numPages : 0;
  }

  /**
   * Returns a Promise<CanvasTexture> for the given page number.
   * Returns from cache if available.
   */
  async getTexture(pageNum) {
    if (this._cache.has(pageNum)) {
      this._touchLRU(pageNum);
      return this._cache.get(pageNum);
    }

    // Coalesce concurrent requests for the same page
    if (this._pending.has(pageNum)) {
      return this._pending.get(pageNum);
    }

    const promise = this._renderPage(pageNum);
    this._pending.set(pageNum, promise);

    try {
      const texture = await promise;
      this._pending.delete(pageNum);
      this._storeInCache(pageNum, texture);
      return texture;
    } catch (err) {
      this._pending.delete(pageNum);
      throw err;
    }
  }

  async _renderPage(pageNum) {
    if (!this._pdf) throw new Error('PDF not loaded');

    const page = await this._pdf.getPage(pageNum);
    const dpr = Math.max(window.devicePixelRatio || 1, MIN_DPR);
    const viewport = page.getViewport({ scale: dpr });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const texture = new CanvasTexture(canvas);
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
   * Prefetch adjacent pages relative to currentPage.
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

  /**
   * Create a placeholder CanvasTexture (grey with loading indicator).
   */
  createPlaceholderTexture(width = 400, height = 600) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e8e8e8';
    ctx.fillRect(0, 0, width, height);
    // Simple loading pattern
    ctx.fillStyle = '#cccccc';
    const size = 40;
    for (let y = 0; y < height; y += size * 2) {
      for (let x = 0; x < width; x += size * 2) {
        ctx.fillRect(x, y, size, size);
        ctx.fillRect(x + size, y + size, size, size);
      }
    }
    const texture = new CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
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
  }
}
