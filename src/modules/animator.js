/**
 * animator.js — 3D Flip Animation
 * Owns the Three.js scene, camera, renderer, and GSAP flip queue.
 *
 * Page turn technique: cylindrical vertex deformation.
 *
 * Two high-segment PlaneGeometries (60 × 10) are deformed each frame so that
 * every vertex follows a cylindrical arc around the spine (x = 0):
 *
 *   u     = |origX| / pageW          (0 = spine, 1 = outer edge)
 *   angle = (π/2) × progress × u
 *   newX  = cos(angle) × origX
 *   newZ  = sin(angle) × |origX| × LIFT_FACTOR
 *
 *   Forward flip (right page turns left):
 *     shrinkMesh (_flipRightMesh): progress 0 → 1  (flat right → vertical)
 *     growMesh   (_flipLeftMesh):  progress 1 → 0  (vertical → flat left)
 *
 *   Backward flip (left page turns right): meshes swapped, same math.
 *
 * PerspectiveCamera is calibrated so the spread at z=0 maps 1:1 to CSS pixels.
 * Objects closer to the camera (the flipping page's arc) appear slightly larger,
 * providing natural foreshortening — the primary 3D depth cue.
 */

import * as THREE from 'three';
import { gsap } from 'gsap';

const LIFT_FACTOR = 0.45;

export class Animator {
  constructor(container, options = {}) {
    this._container = container;
    this._options = options;

    this._pageDims = { pageWidth: 400, pageHeight: 600, spreadWidth: 800, spreadHeight: 600 };
    this._layout = 'double';
    this._currentLeftPage = 1;
    this._totalPages = 1;

    this._scene = null;
    this._camera = null;
    this._renderer = null;

    // Static page meshes
    this._leftMesh = null;
    this._rightMesh = null;

    // Gradient overlays (book-spine curve shadow on static pages)
    this._leftOverlay  = null;
    this._rightOverlay = null;

    // Spine shadow + flip cast shadow
    this._spineMesh     = null;
    this._shadowMesh    = null;
    this._shadowFwdTex  = null; // gradient for forward-flip cast shadow
    this._shadowBwdTex  = null; // gradient for backward-flip cast shadow

    // Flip meshes
    this._flipRightMesh = null;
    this._flipLeftMesh  = null;

    // GSAP queue
    this._flipQueue = [];
    this._currentTimeline = null;
    this._isAnimating = false;

    this._onPageChangeCb    = null;
    this._onAnimationEndCb  = null;
    this._loader = null;

    this._init();
  }

  _init() {
    this._scene = new THREE.Scene();

    this._renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this._renderer.setPixelRatio(window.devicePixelRatio || 1);

    const canvas = this._renderer.domElement;
    canvas.classList.add('pfo-canvas');
    canvas.style.display = 'block';
    this._container.appendChild(canvas);

    this._renderer.setAnimationLoop(() => this._renderFrame());
  }

  setLoader(loader) { this._loader = loader; }
  onPageChange(cb)  { this._onPageChangeCb = cb; }
  onAnimationEnd(cb){ this._onAnimationEndCb = cb; }

  buildScene(pageDims, layout, currentLeftPage, totalPages) {
    this._pageDims = pageDims;
    this._layout = layout;
    this._currentLeftPage = currentLeftPage;
    this._totalPages = totalPages;

    const containerW = this._container.clientWidth;
    const containerH = this._container.clientHeight - 44; // subtract toolbar

    this._renderer.setSize(containerW, containerH);

    // PerspectiveCamera calibrated so the scene at z=0 maps exactly to the
    // container in CSS pixels (1 world unit = 1 pixel at z=0).
    // cameraZ = containerH × 1.0 gives ~53° vFOV — enough perspective that
    // the flipping page's Z arc reads as dramatic depth.
    const cameraZ = containerH * 1.0;
    const fovY = 2 * Math.atan(containerH / 2 / cameraZ) * (180 / Math.PI);
    this._camera = new THREE.PerspectiveCamera(fovY, containerW / containerH, 0.1, cameraZ * 4);
    this._camera.position.set(0, 0, cameraZ);
    this._camera.lookAt(0, 0, 0);

    this._clearMeshes();
    this._buildPageMeshes(pageDims.pageWidth, pageDims.pageHeight, layout);
    this._updateTextures();
  }

  _clearMeshes() {
    // Dispose shadow textures explicitly (they're shared across mesh swaps)
    if (this._shadowFwdTex) { this._shadowFwdTex.dispose(); this._shadowFwdTex = null; }
    if (this._shadowBwdTex) { this._shadowBwdTex.dispose(); this._shadowBwdTex = null; }
    // Null out shadow mesh map so the loop below doesn't double-dispose
    if (this._shadowMesh) this._shadowMesh.material.map = null;

    const meshes = [
      this._leftMesh, this._rightMesh,
      this._leftOverlay, this._rightOverlay,
      this._spineMesh, this._shadowMesh,
      this._flipRightMesh, this._flipLeftMesh,
    ];
    for (const mesh of meshes) {
      if (!mesh) continue;
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
      } else {
        if (mesh.material.map) mesh.material.map.dispose();
        mesh.material.dispose();
      }
    }
    this._leftMesh      = null;
    this._rightMesh     = null;
    this._leftOverlay   = null;
    this._rightOverlay  = null;
    this._spineMesh     = null;
    this._shadowMesh    = null;
    this._flipRightMesh = null;
    this._flipLeftMesh  = null;
  }

  _buildPageMeshes(pageW, pageH, layout) {
    const isDouble = layout === 'double';
    const halfW = pageW / 2;

    // ── Static page meshes ────────────────────────────────────────────────────

    this._leftMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(pageW, pageH),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this._leftMesh.position.set(isDouble ? -halfW : 0, 0, 0);
    this._scene.add(this._leftMesh);

    if (isDouble) {
      this._rightMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pageW, pageH),
        new THREE.MeshBasicMaterial({ color: 0xffffff })
      );
      this._rightMesh.position.set(halfW, 0, 0);
      this._scene.add(this._rightMesh);

      // Spine-curve shadow overlays matching dflip's CSS gradient approach.
      // Left page: spine on right edge — dark at right, transparent at left.
      // Right page: spine on left edge — dark at left, transparent at right.
      // Gradient profile mirrors dflip's:
      //   rgba(0,0,0,0.25) at spine → rgba(0,0,0,0) at 70% of page width.
      const leftTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0)'],
        [0.40, 'rgba(0,0,0,0)'],
        [0.75, 'rgba(0,0,0,0.05)'],
        [0.90, 'rgba(0,0,0,0.10)'],
        [1.0,  'rgba(0,0,0,0.15)'],
      ]);
      this._leftOverlay = new THREE.Mesh(
        new THREE.PlaneGeometry(pageW, pageH),
        new THREE.MeshBasicMaterial({ map: leftTex, transparent: true, depthWrite: false })
      );
      this._leftOverlay.position.set(-halfW, 0, 0.2);
      this._scene.add(this._leftOverlay);

      const rightTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0.15)'],
        [0.10, 'rgba(0,0,0,0.10)'],
        [0.25, 'rgba(0,0,0,0.05)'],
        [0.60, 'rgba(0,0,0,0)'],
        [1.0,  'rgba(0,0,0,0)'],
      ]);
      this._rightOverlay = new THREE.Mesh(
        new THREE.PlaneGeometry(pageW, pageH),
        new THREE.MeshBasicMaterial({ map: rightTex, transparent: true, depthWrite: false })
      );
      this._rightOverlay.position.set(halfW, 0, 0.2);
      this._scene.add(this._rightOverlay);

      // Narrow spine crease — tight gradient centred on the binding seam.
      const spineTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0)'],
        [0.20, 'rgba(0,0,0,0.08)'],
        [0.50, 'rgba(0,0,0,0.18)'],
        [0.80, 'rgba(0,0,0,0.08)'],
        [1,    'rgba(0,0,0,0)'],
      ]);
      this._spineMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(pageW * 0.04, pageH),
        new THREE.MeshBasicMaterial({ map: spineTex, transparent: true, depthWrite: false })
      );
      this._spineMesh.position.set(0, 0, 0.5);
      this._scene.add(this._spineMesh);
    }

    // ── Flip meshes ───────────────────────────────────────────────────────────

    const makeFlipGeo = (translateX) => {
      const g = new THREE.PlaneGeometry(pageW, pageH, 60, 10);
      g.translate(translateX, 0, 0);
      g.userData.originalPositions = g.attributes.position.array.slice();
      const n = g.attributes.position.count;
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      return g;
    };

    this._flipRightMesh = new THREE.Mesh(
      makeFlipGeo(pageW / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.FrontSide })
    );
    this._flipRightMesh.position.set(0, 0, 2);
    this._flipRightMesh.visible = false;
    this._scene.add(this._flipRightMesh);

    this._flipLeftMesh = new THREE.Mesh(
      makeFlipGeo(-pageW / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.FrontSide })
    );
    this._flipLeftMesh.position.set(0, 0, 2);
    this._flipLeftMesh.visible = false;
    this._scene.add(this._flipLeftMesh);

    // Two cast-shadow textures — one per flip direction — so the gradient always
    // reads dark near the spine and transparent toward the outer page edge.
    // Forward flip: page turns from right to left, shadow falls on left page
    //   → gradient transparent at left → dark at right (near spine).
    this._shadowFwdTex = this._makeGradientTex([
      [0,    'rgba(0,0,0,0)'],
      [0.70, 'rgba(0,0,0,0)'],
      [0.88, 'rgba(0,0,0,0.22)'],
      [1.0,  'rgba(0,0,0,0.65)'],
    ]);
    // Backward flip: page turns from left to right, shadow falls on right page
    //   → gradient dark at left (near spine) → transparent at right.
    this._shadowBwdTex = this._makeGradientTex([
      [0,    'rgba(0,0,0,0.65)'],
      [0.12, 'rgba(0,0,0,0.22)'],
      [0.30, 'rgba(0,0,0,0)'],
      [1.0,  'rgba(0,0,0,0)'],
    ]);
    this._shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(pageW, pageH),
      new THREE.MeshBasicMaterial({
        map: this._shadowFwdTex, transparent: true, opacity: 0, depthWrite: false,
      })
    );
    this._shadowMesh.position.set(0, 0, 1); // below flip meshes (z=2) — cast shadow on the receiving page only
    this._scene.add(this._shadowMesh);
  }

  // ── Gradient texture helper ────────────────────────────────────────────────

  /**
   * Creates a CanvasTexture with a horizontal linear gradient.
   * @param {Array<[number, string]>} stops  — [[position, cssColor], …]
   */
  _makeGradientTex(stops) {
    const canvas = document.createElement('canvas');
    canvas.width  = 256;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    for (const [pos, color] of stops) grad.addColorStop(pos, color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 4);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  // ── Cylindrical vertex deformation ────────────────────────────────────────

  /**
   * Bends a flip mesh into a cylindrical arc around the spine (x=0).
   * progress=0 → flat, progress=1 → outer edge pointing toward camera (z=max).
   * Recomputes normals and applies fake shading via vertex colours so the
   * curved surface reads as 3D.
   */
  _deformPage(mesh, progress, pageW) {
    const geo  = mesh.geometry;
    const orig = geo.userData.originalPositions;
    const pos  = geo.attributes.position;

    for (let i = 0; i < pos.count; i++) {
      const i3    = i * 3;
      const origX = orig[i3];
      const origY = orig[i3 + 1];
      const u     = Math.abs(origX) / pageW;
      const a     = (Math.PI / 2) * progress * u;

      pos.setXYZ(i, Math.cos(a) * origX, origY, Math.sin(a) * Math.abs(origX) * LIFT_FACTOR);
    }
    pos.needsUpdate = true;

    geo.computeVertexNormals();
    const nrm    = geo.attributes.normal;
    const colors = geo.attributes.color;
    for (let i = 0; i < pos.count; i++) {
      const i3 = i * 3;
      const u  = Math.abs(orig[i3]) / pageW; // 0 at spine, 1 at outer edge
      const c  = this._shade(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      // Darken near the spine to match the static page overlay profile:
      // 0.15 at spine edge, fading to zero by 20% into the page.
      const spineDark = Math.max(0, 0.15 * (1 - u / 0.20));
      const final = Math.max(0, c - spineDark);
      colors.setXYZ(i, final, final, final);
    }
    colors.needsUpdate = true;
  }

  /** Ambient + diffuse shading from a fixed upper-right light direction. */
  _shade(nx, ny, nz) {
    const LX = 0.3, LY = 0.5, LZ = 1.0;
    const len = Math.sqrt(LX * LX + LY * LY + LZ * LZ);
    const dot = (nx * LX + ny * LY + nz * LZ) / len;
    return 0.68 + 0.32 * Math.max(0, dot);
  }

  // ── Texture management ─────────────────────────────────────────────────────

  async _updateTextures() {
    if (!this._loader) return;
    const lp = this._currentLeftPage;

    if (this._leftMesh) this._applyTexture(this._leftMesh, lp);

    if (this._layout === 'double' && this._rightMesh) {
      const rp = lp + 1;
      if (rp <= this._totalPages) {
        this._applyTexture(this._rightMesh, rp);
      } else {
        this._rightMesh.material.map = null;
        this._rightMesh.material.color.set(0xfafafa);
        this._rightMesh.material.needsUpdate = true;
      }
    }
  }

  async _applyTexture(mesh, pageNum) {
    if (!this._loader || pageNum < 1 || pageNum > this._totalPages) return;
    try {
      const texture = await this._loader.getTexture(pageNum);
      mesh.material.map = texture;
      mesh.material.color.set(0xffffff);
      mesh.material.needsUpdate = true;
    } catch (err) {
      console.warn(`Failed to load texture for page ${pageNum}:`, err);
    }
  }

  // ── Flip queue ─────────────────────────────────────────────────────────────

  flipTo(targetLeftPage, direction) {
    if (targetLeftPage === this._currentLeftPage) return;

    const isQueued = this._flipQueue.length > 0;
    const dur = isQueued
      ? this._options.flipDuration * 0.4
      : this._options.flipDuration;

    this._flipQueue.push({ targetLeftPage, direction, duration: dur });
    if (!this._isAnimating) this._processQueue();
  }

  _processQueue() {
    if (this._flipQueue.length === 0) {
      this._isAnimating = false;
      if (this._onAnimationEndCb) this._onAnimationEndCb();
      return;
    }
    this._isAnimating = true;
    this._executeFlip(this._flipQueue.shift());
  }

  _executeFlip({ targetLeftPage, direction, duration }) {
    const isDouble  = this._layout === 'double';
    const isForward = direction === 'forward';
    const pageW     = this._pageDims.pageWidth;

    const shrinkMesh = isForward ? this._flipRightMesh : this._flipLeftMesh;
    const growMesh   = isForward ? this._flipLeftMesh  : this._flipRightMesh;

    // Textures
    const turningPage = isForward
      ? (isDouble ? this._currentLeftPage + 1 : this._currentLeftPage)
      : this._currentLeftPage;
    this._applyTexture(shrinkMesh, turningPage);

    const backPage = isForward
      ? targetLeftPage
      : Math.min(targetLeftPage + 1, this._totalPages);
    growMesh.material.map = null;
    growMesh.material.color.set(0xffffff);
    this._applyTexture(growMesh, backPage);

    // Update the static mesh that's hidden behind the shrink mesh immediately
    if (isForward) {
      if (isDouble && this._rightMesh) {
        const rp = targetLeftPage + 1;
        if (rp <= this._totalPages) {
          this._applyTexture(this._rightMesh, rp);
        } else {
          this._rightMesh.material.map = null;
          this._rightMesh.material.color.set(0xfafafa);
          this._rightMesh.material.needsUpdate = true;
        }
      }
    } else {
      this._applyTexture(this._leftMesh, targetLeftPage);
    }

    // Position the cast shadow on the page the flip will land on.
    // Forward: shadow lands on left page; backward: on right page.
    // Each direction has its own gradient texture so the shadow always reads
    // dark near the spine and transparent toward the outer page edge.
    if (this._shadowMesh) {
      this._shadowMesh.position.x = isForward ? -halfW(pageW) : halfW(pageW);
      this._shadowMesh.material.map = isForward ? this._shadowFwdTex : this._shadowBwdTex;
      this._shadowMesh.material.opacity = 0;
      this._shadowMesh.material.needsUpdate = true;
    }

    // Reset flip meshes to flat
    this._deformPage(shrinkMesh, 0, pageW);
    this._deformPage(growMesh,   0, pageW);
    shrinkMesh.scale.x   = 1;
    shrinkMesh.position.z = 2;
    shrinkMesh.visible    = true;
    growMesh.scale.x      = 1;
    growMesh.position.z   = 2;
    growMesh.visible      = false;

    const prog = { t: 0 };

    this._currentTimeline = gsap.timeline({
      onComplete: () => {
        this._currentLeftPage = targetLeftPage;
        if (this._shadowMesh) this._shadowMesh.material.opacity = 0;

        // Copy grow mesh texture to the underlying static mesh synchronously
        if (isForward && this._leftMesh) {
          this._leftMesh.material.map = growMesh.material.map;
          this._leftMesh.material.color.set(0xffffff);
          this._leftMesh.material.needsUpdate = true;
        } else if (!isForward && isDouble && this._rightMesh) {
          this._rightMesh.material.map = growMesh.material.map;
          this._rightMesh.material.color.set(0xffffff);
          this._rightMesh.material.needsUpdate = true;
        }

        shrinkMesh.visible = false;
        growMesh.visible   = false;

        this._updateTextures();
        if (this._onPageChangeCb) this._onPageChangeCb(targetLeftPage);
        if (this._loader) this._loader.prefetch(targetLeftPage, this._totalPages);
        this._processQueue();
      },
    });

    this._currentTimeline.to(prog, {
      t: 1,
      duration: duration / 1000,
      ease: 'power2.inOut',
      onUpdate: () => {
        const t = prog.t;

        if (t <= 0.5) {
          // Phase 1: source page bends from flat → vertical
          this._deformPage(shrinkMesh, t / 0.5, pageW);
          shrinkMesh.visible = true;
          growMesh.visible   = false;
        } else {
          // Phase 2: back face bends from vertical → flat on opposite side
          this._deformPage(growMesh, 1 - (t - 0.5) / 0.5, pageW);
          shrinkMesh.visible = false;
          growMesh.visible   = true;
        }

        // Cast shadow on the landing page, peaks at mid-flip
        if (this._shadowMesh) {
          this._shadowMesh.material.opacity = Math.sin(t * Math.PI) * 0.55;
        }
      },
    });
  }

  // ── Queue management ───────────────────────────────────────────────────────

  cancelQueue() {
    this._flipQueue = [];
    if (this._currentTimeline) {
      this._currentTimeline.kill();
      this._currentTimeline = null;
    }
    if (this._flipRightMesh) this._flipRightMesh.visible = false;
    if (this._flipLeftMesh)  this._flipLeftMesh.visible  = false;
    if (this._shadowMesh)    this._shadowMesh.material.opacity = 0;
    this._isAnimating = false;
    this._updateTextures();
  }

  // ── Render loop ────────────────────────────────────────────────────────────

  _renderFrame() {
    if (this._renderer && this._scene && this._camera) {
      this._renderer.render(this._scene, this._camera);
    }
  }

  getCanvas() {
    return this._renderer ? this._renderer.domElement : null;
  }

  get isAnimating() { return this._isAnimating; }

  destroy() {
    this.cancelQueue();
    this._renderer.setAnimationLoop(null);
    this._clearMeshes();
    this._scene.clear();
    this._renderer.dispose();
    if (this._renderer.domElement.parentNode) {
      this._renderer.domElement.parentNode.removeChild(this._renderer.domElement);
    }
  }
}

function halfW(pageW) { return pageW / 2; }
