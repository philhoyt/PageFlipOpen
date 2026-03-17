/**
 * interaction.js — User Input
 * Handles click zones, keyboard navigation, Hammer.js touch/swipe/pinch.
 * Corner drag for manual curl.
 */

import Hammer from 'hammerjs';

const CLICK_ZONE_LEFT = 0.3;    // left 30%
const CLICK_ZONE_RIGHT = 0.7;   // right 70% (so right zone = 30%)
const DRAG_THRESHOLD = 0.3;     // 30% of page width to commit flip

export class Interaction {
  constructor(canvas, container, options = {}) {
    this._canvas = canvas;
    this._container = container;
    this._options = options;

    this._onNext = null;
    this._onPrev = null;
    this._onFirst = null;
    this._onLast = null;
    this._onZoomIn = null;
    this._onZoomOut = null;
    this._onToggleFullscreen = null;
    this._onDragCurl = null;
    this._onDragRelease = null;

    this._hammer = null;
    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragSide = null; // 'left' | 'right'

    this._boundKeyDown = this._onKeyDown.bind(this);
    this._boundMouseDown = this._onMouseDown.bind(this);
    this._boundMouseMove = this._onMouseMove.bind(this);
    this._boundMouseUp = this._onMouseUp.bind(this);
    this._boundClick = this._onClick.bind(this);

    this._init();
  }

  _init() {
    if (this._options.enableKeyboard !== false) {
      document.addEventListener('keydown', this._boundKeyDown);
    }

    this._canvas.addEventListener('mousedown', this._boundMouseDown);
    this._canvas.addEventListener('click', this._boundClick);
    document.addEventListener('mousemove', this._boundMouseMove);
    document.addEventListener('mouseup', this._boundMouseUp);

    if (this._options.enableTouch !== false) {
      this._initHammer();
    }
  }

  _initHammer() {
    this._hammer = new Hammer(this._canvas, {
      touchAction: 'none',
    });

    // Swipe
    this._hammer.get('swipe').set({
      direction: Hammer.DIRECTION_HORIZONTAL,
      threshold: 20,
      velocity: 0.3,
    });

    this._hammer.on('swipeleft', () => {
      if (this._onNext) this._onNext();
    });
    this._hammer.on('swiperight', () => {
      if (this._onPrev) this._onPrev();
    });

    // Pinch
    this._hammer.get('pinch').set({ enable: true });
    let lastPinchScale = 1;

    this._hammer.on('pinchstart', () => {
      lastPinchScale = 1;
    });

    this._hammer.on('pinchmove', (e) => {
      const delta = e.scale / lastPinchScale;
      lastPinchScale = e.scale;
      if (this._onPinch) this._onPinch(delta, e.center);
    });

    // Double tap → zoom in
    this._hammer.get('doubletap').set({ enable: true });
    this._hammer.on('doubletap', (e) => {
      if (this._onDoubleTap) this._onDoubleTap(e.center);
    });
  }

  // --- Event handlers ---

  _onClick(e) {
    if (this._isDragging) return; // was a drag, not a click

    const rect = this._canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;

    if (relX < CLICK_ZONE_LEFT) {
      if (this._onPrev) this._onPrev();
    } else if (relX > CLICK_ZONE_RIGHT) {
      if (this._onNext) this._onNext();
    }
    // Middle zone: no navigation
  }

  _onMouseDown(e) {
    const rect = this._canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;

    // Corner drag — corners are within 20% of x and 20% of y
    const isCorner = (relY > 0.8 || relY < 0.2) && (relX < 0.15 || relX > 0.85);

    if (isCorner) {
      this._isDragging = false; // will be set true on move
      this._dragStartX = e.clientX;
      this._dragStartY = e.clientY;
      this._dragSide = relX < 0.5 ? 'left' : 'right';
      this._dragStartCanvasX = relX;
    }
  }

  _onMouseMove(e) {
    if (this._dragStartX === 0 && this._dragStartY === 0) return;

    const dx = e.clientX - this._dragStartX;
    const dy = e.clientY - this._dragStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 5) {
      this._isDragging = true;
      const rect = this._canvas.getBoundingClientRect();
      const relX = (e.clientX - rect.left) / rect.width;
      const progress = Math.abs(relX - this._dragStartCanvasX);
      if (this._onDragCurl) {
        this._onDragCurl(progress, this._dragSide);
      }
    }
  }

  _onMouseUp(e) {
    if (!this._isDragging) {
      this._dragStartX = 0;
      this._dragStartY = 0;
      this._dragSide = null;
      return;
    }

    const rect = this._canvas.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const dragAmount = Math.abs(relX - this._dragStartCanvasX);

    if (this._onDragRelease) {
      // commit if dragged > 30% of canvas width
      const commit = dragAmount > DRAG_THRESHOLD;
      this._onDragRelease(commit, this._dragSide);
    }

    this._isDragging = false;
    this._dragStartX = 0;
    this._dragStartY = 0;
    this._dragSide = null;
  }

  _onKeyDown(e) {
    // Only handle if no input is focused
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

  onNext(cb) { this._onNext = cb; }
  onPrev(cb) { this._onPrev = cb; }
  onFirst(cb) { this._onFirst = cb; }
  onLast(cb) { this._onLast = cb; }
  onZoomIn(cb) { this._onZoomIn = cb; }
  onZoomOut(cb) { this._onZoomOut = cb; }
  onToggleFullscreen(cb) { this._onToggleFullscreen = cb; }
  onEscape(cb) { this._onEscape = cb; }
  onPinch(cb) { this._onPinch = cb; }
  onDoubleTap(cb) { this._onDoubleTap = cb; }
  onDragCurl(cb) { this._onDragCurl = cb; }
  onDragRelease(cb) { this._onDragRelease = cb; }

  destroy() {
    document.removeEventListener('keydown', this._boundKeyDown);
    this._canvas.removeEventListener('mousedown', this._boundMouseDown);
    this._canvas.removeEventListener('click', this._boundClick);
    document.removeEventListener('mousemove', this._boundMouseMove);
    document.removeEventListener('mouseup', this._boundMouseUp);

    if (this._hammer) {
      this._hammer.destroy();
      this._hammer = null;
    }
  }
}
