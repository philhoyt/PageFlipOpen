/**
 * PageFlipOpen.js — Main Class
 * Self-contained JavaScript class that renders a PDF as an interactive 3D flipbook.
 * MIT Licensed.
 */

import { Loader, setPdfWorkerSrc } from './modules/loader.js';
import { Layout } from './modules/layout.js';
import { Animator } from './modules/animator.js';
import { Interaction } from './modules/interaction.js';
import { Viewport } from './modules/viewport.js';
import { Toolbar } from './modules/toolbar.js';

const DEFAULTS = {
  source: null,
  startPage: 1,
  autoLayout: true,
  singlePageMode: false,
  zoom: 1,
  zoomMin: 1,
  zoomMax: 3,
  backgroundColor: 'transparent',
  pageBackground: '#fff',
  flipDuration: 800,
  enableSound: false,
  soundUrl: null,
  enableFullscreen: true,
  enableDownload: false,
  downloadFilename: null,
  enableKeyboard: true,
  enableTouch: true,
  toolbar: true,
  toolbarAlwaysVisible: false,
  onReady: null,
  onPageChange: null,
  onError: null,
};

export class PageFlipOpen {
  constructor(container, options = {}) {
    if (!container || !(container instanceof HTMLElement)) {
      throw new Error('PageFlipOpen: first argument must be an HTMLElement');
    }

    this._container = container;
    this._options = { ...DEFAULTS, ...options };

    // Public read-only state
    this.currentPage = this._options.startPage;
    this.totalPages = 0;
    this.layout = 'double';

    // Modules
    this._loader = null;
    this._layout = null;
    this._animator = null;
    this._interaction = null;
    this._viewport = null;
    this._toolbar = null;

    this._ready = false;
    this._destroyed = false;

    this._setupContainer();
    this._initModules();
    this._load();
  }

  _setupContainer() {
    this._container.classList.add('pfo-flipbook');
    this._container.style.position = 'relative';
    this._container.style.overflow = 'hidden';
    this._container.style.backgroundColor = this._options.backgroundColor;
    this._container.style.setProperty('--pfo-bg', this._options.backgroundColor);
    this._container.style.setProperty('--pfo-page-bg', this._options.pageBackground);
  }

  _initModules() {
    // Loader
    this._loader = new Loader();

    // Layout
    this._layout = new Layout(this._container);
    this._layout.onLayoutChange((newLayout) => {
      this.layout = newLayout;
      if (this._animator && this._ready) {
        const dims = this._layout.getPageDimensions();
        const dpr = window.devicePixelRatio || 1;
        this._loader.setRenderScale(dims.scale * dpr * 1.5);
        const leftPage = this._layout.getSpreadLeftPage(this.currentPage);
        this._animator.buildScene(dims, newLayout, leftPage, this.totalPages);
      }
    });

    this._layout.onResize(() => {
      if (this._animator && this._ready) {
        const dims = this._layout.getPageDimensions();
        const dpr = window.devicePixelRatio || 1;
        this._loader.setRenderScale(dims.scale * dpr * 1.5);
        this._animator.resize(dims);
      }
    });

    // Animator
    this._animator = new Animator(this._container, this._options);
    this._animator.setLoader(this._loader);
    this._animator.onPageChange((leftPage) => {
      this.currentPage = leftPage;
      if (this._toolbar) this._toolbar.setPage(this.currentPage, this.totalPages);
      if (this._options.onPageChange) this._options.onPageChange(this.currentPage);
    });

    // Toolbar (build early; interactions wired after animator canvas is available)
    this._toolbar = new Toolbar(this._container, this._options);
    this._toolbar.on('first', () => this.first());
    this._toolbar.on('prev', () => this.prev());
    this._toolbar.on('next', () => this.next());
    this._toolbar.on('last', () => this.last());
    this._toolbar.on('zoomIn', () => this.zoomIn());
    this._toolbar.on('zoomOut', () => this.zoomOut());
    this._toolbar.on('toggleFullscreen', () => this.toggleFullscreen());
    this._toolbar.on('download', () => this._downloadPDF());
    this._toolbar.on('flipTo', (page) => this.flipTo(page));
  }

  async _load() {
    if (!this._options.source) {
      const err = new Error('PageFlipOpen: options.source is required');
      this._handleError(err);
      return;
    }

    try {
      const { totalPages, pageDimensions } = await this._loader.load(this._options.source);
      this.totalPages = totalPages;

      // Init layout
      this._layout.init(
        pageDimensions,
        totalPages,
        this._options.singlePageMode || !this._options.autoLayout
      );
      this.layout = this._layout.getCurrentLayout();

      // Clamp startPage to valid range then normalise to spread left page
      const clamped = Math.max(1, Math.min(this._options.startPage, totalPages));
      const leftPage = this._layout.getSpreadLeftPage(clamped);
      this.currentPage = leftPage;

      // Build the Three.js scene
      const dims = this._layout.getPageDimensions();

      // Render at device-pixel resolution: dims.scale (display px per PDF pt) × dpr.
      // The ×1.5 oversample keeps sub-pixel text sharp without exploding memory.
      const dpr = window.devicePixelRatio || 1;
      this._loader.setRenderScale(dims.scale * dpr * 1.5);

      this._animator.buildScene(dims, this.layout, leftPage, totalPages);

      // Viewport (wrap animator canvas)
      const canvas = this._animator.getCanvas();
      this._viewport = new Viewport(canvas, this._container, this._options);
      this._viewport.onZoomChange((percent) => {
        if (this._toolbar) this._toolbar.setZoom(percent);
      });
      this._viewport.onFullscreenChange((isFullscreen) => {
        if (this._toolbar) this._toolbar.setFullscreen(isFullscreen);
        // Re-trigger layout on fullscreen change
        const dims = this._layout.getPageDimensions();
        const lp = this._layout.getSpreadLeftPage(this.currentPage);
        this._animator.buildScene(dims, this.layout, lp, this.totalPages);
      });

      // Interaction
      this._interaction = new Interaction(canvas, this._container, this._options);
      this._interaction.onNext(() => this.next());
      this._interaction.onPrev(() => this.prev());
      this._interaction.onFirst(() => this.first());
      this._interaction.onLast(() => this.last());
      this._interaction.onZoomIn(() => this.zoomIn());
      this._interaction.onZoomOut(() => this.zoomOut());
      this._interaction.onToggleFullscreen(() => this.toggleFullscreen());
      this._interaction.onEscape(() => {
        if (this._viewport && this._viewport.isFullscreen) {
          document.exitFullscreen();
        }
      });
      this._interaction.onPinch((scaleDelta, center) => {
        if (this._viewport) this._viewport.adjustZoom(scaleDelta, center);
      });
      this._interaction.onDoubleTap(() => {
        if (this._viewport) {
          const scale = this._viewport.getScale();
          if (scale > 1.1) {
            this.zoomReset();
          } else {
            this.zoomIn();
          }
        }
      });

      // Toolbar initial state
      if (this._toolbar) {
        this._toolbar.setPage(this.currentPage, totalPages);
        this._toolbar.setZoom(100);
      }

      // Prefetch initial pages
      this._loader.prefetch(this.currentPage, totalPages);

      this._ready = true;

      if (this._options.onReady) {
        this._options.onReady();
      }
    } catch (err) {
      this._handleError(err);
    }
  }

  _handleError(err) {
    console.error('PageFlipOpen error:', err);
    if (this._options.onError) {
      this._options.onError(err);
    }
  }

  // --- Public API ---

  /**
   * Flip to a specific page number.
   */
  flipTo(pageNum) {
    if (!this._ready || this._destroyed) return;

    const target = Math.max(1, Math.min(pageNum, this.totalPages));
    const targetLeft = this._layout.getSpreadLeftPage(target);

    if (targetLeft === this.currentPage) return;

    const direction = targetLeft > this.currentPage ? 'forward' : 'backward';
    this._animator.flipTo(targetLeft, direction);
  }

  next() {
    if (!this._ready || this._destroyed) return;
    const nextLeft = this._layout.getNextSpreadPage(this.currentPage);
    if (nextLeft !== this.currentPage) {
      this.flipTo(nextLeft);
    }
  }

  prev() {
    if (!this._ready || this._destroyed) return;
    const prevLeft = this._layout.getPrevSpreadPage(this.currentPage);
    if (prevLeft !== this.currentPage) {
      this.flipTo(prevLeft);
    }
  }

  first() {
    this.flipTo(1);
  }

  last() {
    this.flipTo(this.totalPages);
  }

  zoomIn() {
    if (this._viewport) this._viewport.zoomIn();
  }

  zoomOut() {
    if (this._viewport) this._viewport.zoomOut();
  }

  zoomReset() {
    if (this._viewport) this._viewport.zoomReset();
  }

  toggleFullscreen() {
    if (this._viewport) this._viewport.toggleFullscreen();
  }

  _downloadPDF() {
    if (!this._options.source) return;
    const a = document.createElement('a');
    a.href = this._options.source;
    a.download = this._options.downloadFilename || this._options.source.split('/').pop() || 'document.pdf';
    a.click();
  }

  get isAnimating() {
    return this._animator ? this._animator.isAnimating : false;
  }

  /**
   * Destroy the flipbook instance and clean up all resources.
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;

    if (this._interaction) { this._interaction.destroy(); this._interaction = null; }
    if (this._viewport) { this._viewport.destroy(); this._viewport = null; }
    if (this._toolbar) { this._toolbar.destroy(); this._toolbar = null; }
    if (this._animator) { this._animator.destroy(); this._animator = null; }
    if (this._layout) { this._layout.destroy(); this._layout = null; }
    if (this._loader) { this._loader.destroy(); this._loader = null; }

    this._container.classList.remove('pfo-flipbook');
  }
}

/**
 * Set the PDF.js worker source URL.
 * Required when using the IIFE bundle where import.meta.url is unavailable.
 * Call before creating any PageFlipOpen instance.
 *
 * @example
 * PageFlipOpen.setPdfWorkerSrc('/path/to/pdf.worker.mjs');
 */
PageFlipOpen.setPdfWorkerSrc = setPdfWorkerSrc;

export default PageFlipOpen;
