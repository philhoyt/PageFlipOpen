/**
 * toolbar.js — UI Controls
 * Injects toolbar HTML, wires buttons, keeps display in sync.
 * Pure DOM, no external dependencies.
 */

// SVG icons as inline strings
const ICONS = {
  first: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>`,
  prev:  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  next:  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  last:  `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>`,
  zoomIn:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  zoomOut:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>`,
  fullscreen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`,
  exitFullscreen: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/></svg>`,
};

const FADE_TIMEOUT_MS = 2000;

export class Toolbar {
  constructor(container, options = {}) {
    this._container = container;
    this._options = options;
    this._el = null;
    this._pageInput = null;
    this._totalPagesEl = null;
    this._zoomEl = null;
    this._btnFirst = null;
    this._btnPrev = null;
    this._btnNext = null;
    this._btnLast = null;
    this._btnZoomIn = null;
    this._btnZoomOut = null;
    this._btnFullscreen = null;

    this._currentPage = 1;
    this._totalPages = 1;
    this._fadeTimer = null;
    this._visible = true;

    this._callbacks = {};

    this._boundInteractionHandler = this._resetFadeTimer.bind(this);

    if (options.toolbar !== false) {
      this._build();
    }
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'pfo-toolbar';
    el.innerHTML = `
      <div class="pfo-toolbar-group">
        <button class="pfo-btn pfo-btn-first" title="First page" aria-label="First page">${ICONS.first}</button>
        <button class="pfo-btn pfo-btn-prev" title="Previous page" aria-label="Previous page">${ICONS.prev}</button>
        <div class="pfo-page-info">
          <input class="pfo-page-input" type="number" min="1" aria-label="Current page" />
          <span class="pfo-page-sep">of</span>
          <span class="pfo-page-total">1</span>
        </div>
        <button class="pfo-btn pfo-btn-next" title="Next page" aria-label="Next page">${ICONS.next}</button>
        <button class="pfo-btn pfo-btn-last" title="Last page" aria-label="Last page">${ICONS.last}</button>
      </div>
      <div class="pfo-toolbar-divider"></div>
      <div class="pfo-toolbar-group">
        <button class="pfo-btn pfo-btn-zoom-out" title="Zoom out" aria-label="Zoom out">${ICONS.zoomOut}</button>
        <span class="pfo-zoom-level">100%</span>
        <button class="pfo-btn pfo-btn-zoom-in" title="Zoom in" aria-label="Zoom in">${ICONS.zoomIn}</button>
      </div>
      <div class="pfo-toolbar-divider"></div>
      <div class="pfo-toolbar-group">
        <button class="pfo-btn pfo-btn-fullscreen" title="Toggle fullscreen" aria-label="Toggle fullscreen">${ICONS.fullscreen}</button>
      </div>
    `;

    this._el = el;
    this._container.appendChild(el);

    // Cache references
    this._pageInput = el.querySelector('.pfo-page-input');
    this._totalPagesEl = el.querySelector('.pfo-page-total');
    this._zoomEl = el.querySelector('.pfo-zoom-level');
    this._btnFirst = el.querySelector('.pfo-btn-first');
    this._btnPrev = el.querySelector('.pfo-btn-prev');
    this._btnNext = el.querySelector('.pfo-btn-next');
    this._btnLast = el.querySelector('.pfo-btn-last');
    this._btnZoomIn = el.querySelector('.pfo-btn-zoom-in');
    this._btnZoomOut = el.querySelector('.pfo-btn-zoom-out');
    this._btnFullscreen = el.querySelector('.pfo-btn-fullscreen');

    // Button events
    this._btnFirst.addEventListener('click', () => this._emit('first'));
    this._btnPrev.addEventListener('click', () => this._emit('prev'));
    this._btnNext.addEventListener('click', () => this._emit('next'));
    this._btnLast.addEventListener('click', () => this._emit('last'));
    this._btnZoomIn.addEventListener('click', () => this._emit('zoomIn'));
    this._btnZoomOut.addEventListener('click', () => this._emit('zoomOut'));
    this._btnFullscreen.addEventListener('click', () => this._emit('toggleFullscreen'));

    // Page number input
    this._pageInput.addEventListener('change', () => {
      const val = parseInt(this._pageInput.value, 10);
      if (!isNaN(val) && val >= 1 && val <= this._totalPages) {
        this._emit('flipTo', val);
      } else {
        this._pageInput.value = this._currentPage;
      }
    });
    this._pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._pageInput.blur();
    });

    // Fade behavior
    if (this._options.toolbarAlwaysVisible) {
      this._show();
    } else {
      this._container.addEventListener('mousemove', this._boundInteractionHandler);
      this._container.addEventListener('touchstart', this._boundInteractionHandler);
      el.addEventListener('mouseenter', () => {
        clearTimeout(this._fadeTimer);
        this._show();
      });
      this._resetFadeTimer();
    }
  }

  _emit(event, data) {
    if (this._callbacks[event]) this._callbacks[event](data);
  }

  on(event, cb) {
    this._callbacks[event] = cb;
  }

  _show() {
    this._visible = true;
    if (this._el) {
      this._el.classList.remove('pfo-toolbar--hidden');
      this._el.classList.add('pfo-toolbar--visible');
    }
  }

  _hide() {
    this._visible = false;
    if (this._el) {
      this._el.classList.remove('pfo-toolbar--visible');
      this._el.classList.add('pfo-toolbar--hidden');
    }
  }

  _resetFadeTimer() {
    this._show();
    clearTimeout(this._fadeTimer);
    this._fadeTimer = setTimeout(() => this._hide(), FADE_TIMEOUT_MS);
  }

  setPage(pageNum, totalPages) {
    this._currentPage = pageNum;
    this._totalPages = totalPages;

    if (this._pageInput) this._pageInput.value = pageNum;
    if (this._totalPagesEl) this._totalPagesEl.textContent = totalPages;
    if (this._pageInput) this._pageInput.max = totalPages;

    this._updateButtonStates(pageNum, totalPages);
  }

  _updateButtonStates(pageNum, totalPages) {
    if (!this._btnFirst) return;
    const atFirst = pageNum <= 1;
    const atLast = pageNum >= totalPages;
    this._btnFirst.disabled = atFirst;
    this._btnPrev.disabled = atFirst;
    this._btnNext.disabled = atLast;
    this._btnLast.disabled = atLast;
  }

  setZoom(percent) {
    if (this._zoomEl) this._zoomEl.textContent = `${percent}%`;
  }

  setFullscreen(isFullscreen) {
    if (!this._btnFullscreen) return;
    this._btnFullscreen.innerHTML = isFullscreen ? ICONS.exitFullscreen : ICONS.fullscreen;
    this._btnFullscreen.title = isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen';
  }

  destroy() {
    clearTimeout(this._fadeTimer);
    this._container.removeEventListener('mousemove', this._boundInteractionHandler);
    this._container.removeEventListener('touchstart', this._boundInteractionHandler);
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}
