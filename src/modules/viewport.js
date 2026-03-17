/**
 * viewport.js — Zoom & Fullscreen
 * Wraps the Three.js renderer canvas in a Panzoom instance.
 */

import Panzoom from '@panzoom/panzoom';

export class Viewport {
  constructor(canvas, container, options = {}) {
    this._canvas = canvas;
    this._container = container;
    this._options = options;
    this._panzoom = null;
    this._onZoomChangeCb = null;
    this._isFullscreen = false;

    this._boundFullscreenChange = this._onFullscreenChange.bind(this);
    this._boundPointerUp = () => {
      const scale = this._panzoom ? this._panzoom.getScale() : 1;
      if (scale > 1.01) this._canvas.style.cursor = 'grab';
    };
    this._boundWheelHandler = null;

    this._init();
  }

  _init() {
    // Wrap canvas in a panzoom container div (styled entirely by .pfo-panzoom-wrapper in CSS)
    const wrapper = document.createElement('div');
    wrapper.classList.add('pfo-panzoom-wrapper');

    const parent = this._canvas.parentNode;
    parent.insertBefore(wrapper, this._canvas);
    wrapper.appendChild(this._canvas);
    this._wrapper = wrapper;

    this._panzoom = Panzoom(this._canvas, {
      maxScale: this._options.zoomMax || 3,
      minScale: this._options.zoomMin || 1,
      step: 0.25,
      contain: 'outside',
      cursor: 'default',
      touchAction: 'none',
      // Disable pan at scale 1
      startScale: this._options.zoom || 1,
    });

    // Mouse wheel zoom
    this._boundWheelHandler = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this._panzoom.zoomWithWheel(e);
      }
    };
    wrapper.addEventListener('wheel', this._boundWheelHandler, { passive: false });

    // Pan cursor management + zoom change notifications
    this._canvas.addEventListener('panzoomchange', (e) => {
      const scale = e.detail.scale;
      if (scale <= 1.01) {
        this._panzoom.pan(0, 0, { animate: false });
        this._canvas.style.cursor = 'default';
      } else {
        this._canvas.style.cursor = 'grab';
      }
      if (this._onZoomChangeCb) {
        this._onZoomChangeCb(Math.round(scale * 100));
      }
    });

    this._canvas.addEventListener('pointerdown', () => {
      const scale = this._panzoom.getScale();
      if (scale > 1.01) this._canvas.style.cursor = 'grabbing';
    });
    document.addEventListener('pointerup', this._boundPointerUp);

    if (this._options.enableFullscreen !== false) {
      document.addEventListener('fullscreenchange', this._boundFullscreenChange);
    }
  }

  onZoomChange(cb) {
    this._onZoomChangeCb = cb;
  }

  onFullscreenChange(cb) {
    this._onFullscreenChangeCb = cb;
  }

  zoomIn() {
    this._panzoom.zoomIn();
  }

  zoomOut() {
    this._panzoom.zoomOut();
  }

  zoomReset() {
    this._panzoom.reset({ animate: true });
  }

  /**
   * Adjust zoom by a delta multiplier (used by Hammer.js pinch).
   */
  adjustZoom(scaleDelta, focalPoint) {
    const currentScale = this._panzoom.getScale();
    const newScale = currentScale * scaleDelta;
    if (focalPoint) {
      this._panzoom.zoom(newScale, {
        animate: false,
        focal: focalPoint,
      });
    } else {
      this._panzoom.zoom(newScale, { animate: false });
    }
  }

  getScale() {
    return this._panzoom ? this._panzoom.getScale() : 1;
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this._container.requestFullscreen().catch(err => {
        console.warn('Fullscreen failed:', err);
      });
    } else {
      document.exitFullscreen();
    }
  }

  _onFullscreenChange() {
    this._isFullscreen = !!document.fullscreenElement;
    if (this._onFullscreenChangeCb) {
      this._onFullscreenChangeCb(this._isFullscreen);
    }
  }

  get isFullscreen() {
    return this._isFullscreen;
  }

  destroy() {
    if (this._panzoom) {
      this._panzoom.destroy();
      this._panzoom = null;
    }
    if (this._wrapper && this._canvas.parentNode === this._wrapper) {
      const grandParent = this._wrapper.parentNode;
      if (grandParent) {
        grandParent.insertBefore(this._canvas, this._wrapper);
        grandParent.removeChild(this._wrapper);
      }
    }
    if (this._boundWheelHandler && this._wrapper) {
      this._wrapper.removeEventListener('wheel', this._boundWheelHandler);
    }
    document.removeEventListener('pointerup', this._boundPointerUp);
    document.removeEventListener('fullscreenchange', this._boundFullscreenChange);
  }
}
