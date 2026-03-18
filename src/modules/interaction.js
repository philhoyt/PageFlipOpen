/**
 * interaction.js — User Input
 * Handles click zones, keyboard navigation, and Hammer.js touch/swipe/pinch.
 */

import Hammer from 'hammerjs';

const CLICK_ZONE_LEFT  = 0.3; // left 30% of canvas triggers prev
const CLICK_ZONE_RIGHT = 0.7; // right 30% of canvas triggers next

export class Interaction {
  constructor(canvas, container, options = {}) {
    this._canvas = canvas;
    this._container = container;
    this._options = options;

    this._onNext            = null;
    this._onPrev            = null;
    this._onFirst           = null;
    this._onLast            = null;
    this._onZoomIn          = null;
    this._onZoomOut         = null;
    this._onToggleFullscreen = null;
    this._onEscape          = null;
    this._onPinch           = null;
    this._onDoubleTap       = null;

    this._hammer = null;

    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundClick   = this._onClick.bind(this);

    this._init();
  }

  _init() {
    if (this._options.enableKeyboard !== false) {
      document.addEventListener('keydown', this._boundKeyDown);
    }

    this._canvas.addEventListener('click', this._boundClick);

    if (this._options.enableTouch !== false) {
      this._initHammer();
    }
  }

  _initHammer() {
    this._hammer = new Hammer(this._canvas, { touchAction: 'none' });

    this._hammer.get('swipe').set({
      direction: Hammer.DIRECTION_HORIZONTAL,
      threshold: 20,
      velocity: 0.3,
    });
    this._hammer.on('swipeleft',  () => { if (this._onNext) this._onNext(); });
    this._hammer.on('swiperight', () => { if (this._onPrev) this._onPrev(); });

    this._hammer.get('pinch').set({ enable: this._options.enableZoom !== false });
    let lastPinchScale = 1;
    this._hammer.on('pinchstart', () => { lastPinchScale = 1; });
    this._hammer.on('pinchmove', (e) => {
      const delta = e.scale / lastPinchScale;
      lastPinchScale = e.scale;
      if (this._onPinch) this._onPinch(delta, e.center);
    });

    this._hammer.get('doubletap').set({ enable: true });
    this._hammer.on('doubletap', (e) => {
      if (this._onDoubleTap) this._onDoubleTap(e.center);
    });
  }

  _onClick(e) {
    const rect = this._canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;

    if (relX < CLICK_ZONE_LEFT) {
      if (this._onPrev) this._onPrev();
    } else if (relX > CLICK_ZONE_RIGHT) {
      if (this._onNext) this._onNext();
    }
  }

  _onKeyDown(e) {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        if (this._onNext) this._onNext();
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        if (this._onPrev) this._onPrev();
        break;
      case 'Home':
        e.preventDefault();
        if (this._onFirst) this._onFirst();
        break;
      case 'End':
        e.preventDefault();
        if (this._onLast) this._onLast();
        break;
      case '+':
      case '=':
        e.preventDefault();
        if (this._onZoomIn) this._onZoomIn();
        break;
      case '-':
        e.preventDefault();
        if (this._onZoomOut) this._onZoomOut();
        break;
      case 'f':
      case 'F':
        e.preventDefault();
        if (this._onToggleFullscreen) this._onToggleFullscreen();
        break;
      case 'Escape':
        if (this._onEscape) this._onEscape();
        break;
    }
  }

  // --- Callback setters ---

  onNext(cb)             { this._onNext = cb; }
  onPrev(cb)             { this._onPrev = cb; }
  onFirst(cb)            { this._onFirst = cb; }
  onLast(cb)             { this._onLast = cb; }
  onZoomIn(cb)           { this._onZoomIn = cb; }
  onZoomOut(cb)          { this._onZoomOut = cb; }
  onToggleFullscreen(cb) { this._onToggleFullscreen = cb; }
  onEscape(cb)           { this._onEscape = cb; }
  onPinch(cb)            { this._onPinch = cb; }
  onDoubleTap(cb)        { this._onDoubleTap = cb; }

  destroy() {
    document.removeEventListener('keydown', this._boundKeyDown);
    this._canvas.removeEventListener('click', this._boundClick);
    if (this._hammer) {
      this._hammer.destroy();
      this._hammer = null;
    }
  }
}
