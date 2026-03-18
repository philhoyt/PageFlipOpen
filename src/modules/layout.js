/**
 * layout.js — Page Layout Detection
 * Determines single vs double page mode, calculates geometry, handles resize.
 */

import { TOOLBAR_HEIGHT } from './constants.js';

const RESIZE_DEBOUNCE_MS = 100;
const BOOK_PADDING = 0.88; // book fills 88% of container — leaves breathing room

export class Layout {
  constructor(container) {
    this._container = container;
    this._pageDimensions = { width: 0, height: 0 }; // PDF page dims at scale 1
    this._totalPages = 0;
    this._currentLayout = 'double'; // 'single' | 'double'
    this._forceSingle = false;
    this._changeCallbacks = [];
    this._resizeCallbacks = [];
    this._resizeTimer = null;

    this._boundTrigger = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._onResize(), RESIZE_DEBOUNCE_MS);
    };

    this._observer = new ResizeObserver(this._boundTrigger);
    this._observer.observe(this._container);
    window.addEventListener('resize', this._boundTrigger);
  }

  init(pageDimensions, totalPages, forceSingle = false) {
    this._pageDimensions = pageDimensions;
    this._totalPages = totalPages;
    this._forceSingle = forceSingle;
    this._currentLayout = this._detectLayout();
  }

  _detectLayout() {
    if (this._forceSingle) return 'single';

    const { width: pageW, height: pageH } = this._pageDimensions;

    // Landscape PDF → single page mode
    if (pageW > pageH) return 'single';

    return 'double';
  }

  _onResize() {
    const newLayout = this._detectLayout();
    const layoutChanged = newLayout !== this._currentLayout;
    this._currentLayout = newLayout;

    if (layoutChanged) {
      // Layout type changed (single ↔ double) — full rebuild needed
      for (const cb of this._changeCallbacks) cb(this._currentLayout);
    } else {
      // Same layout, container just resized — lightweight resize
      for (const cb of this._resizeCallbacks) cb(this._currentLayout);
    }
  }

  onLayoutChange(callback) {
    this._changeCallbacks.push(callback);
  }

  onResize(callback) {
    this._resizeCallbacks.push(callback);
  }

  getCurrentLayout() {
    return this._currentLayout;
  }

  /**
   * Returns { pageWidth, pageHeight, spreadWidth, spreadHeight, scale }
   * representing the final display dimensions for one page fitted into container.
   */
  getPageDimensions() {
    const containerW = this._container.clientWidth;
    const containerH = this._container.clientHeight;
    const { width: pdfW, height: pdfH } = this._pageDimensions;
    const availableH = containerH - TOOLBAR_HEIGHT;

    const spreadCols = this._currentLayout === 'double' ? 2 : 1;
    const availableW = containerW * BOOK_PADDING;
    const availableH_padded = availableH * BOOK_PADDING;

    // Fit the spread into the available area, preserving PDF aspect ratio
    const spreadW = pdfW * spreadCols;
    const spreadH = pdfH;

    const scaleW = availableW / spreadW;
    const scaleH = availableH_padded / spreadH;
    const scale = Math.min(scaleW, scaleH);

    return {
      pageWidth: pdfW * scale,
      pageHeight: pdfH * scale,
      spreadWidth: pdfW * spreadCols * scale,
      spreadHeight: pdfH * scale,
      scale,
      pdfPageWidth: pdfW,
      pdfPageHeight: pdfH,
    };
  }

  /**
   * Returns the spread (array of page numbers) that contains the given page.
   * Page 1 is always alone (cover). Last page alone if odd total.
   */
  getSpreadForPage(pageNum) {
    if (this._currentLayout === 'single') {
      return [pageNum];
    }

    // Double page mode
    if (pageNum === 1) return [1];

    // Last page alone if odd total
    if (this._totalPages % 2 === 0 && pageNum === this._totalPages) {
      return [this._totalPages];
    }

    // Pages 2-3, 4-5, etc.
    if (pageNum % 2 === 0) {
      const next = pageNum + 1;
      if (next <= this._totalPages) return [pageNum, next];
      return [pageNum];
    } else {
      const prev = pageNum - 1;
      if (prev >= 2) return [prev, pageNum];
      return [pageNum];
    }
  }

  /**
   * Returns the left page number of a spread, given a page number.
   */
  getSpreadLeftPage(pageNum) {
    const spread = this.getSpreadForPage(pageNum);
    return spread[0];
  }

  /**
   * Returns the next spread's left page number.
   */
  getNextSpreadPage(currentLeftPage) {
    if (this._currentLayout === 'single') {
      return Math.min(currentLeftPage + 1, this._totalPages);
    }
    if (currentLeftPage === 1) return 2;
    return Math.min(currentLeftPage + 2, this._totalPages);
  }

  /**
   * Returns the previous spread's left page number.
   */
  getPrevSpreadPage(currentLeftPage) {
    if (this._currentLayout === 'single') {
      return Math.max(currentLeftPage - 1, 1);
    }
    if (currentLeftPage === 2 || currentLeftPage === 3) return 1;
    return Math.max(currentLeftPage - 2, 1);
  }

  destroy() {
    clearTimeout(this._resizeTimer);
    this._observer.disconnect();
    window.removeEventListener('resize', this._boundTrigger);
    this._changeCallbacks = [];
    this._resizeCallbacks = [];
  }
}
