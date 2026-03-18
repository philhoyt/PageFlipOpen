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

import {
  Vector3,
  Scene,
  Group,
  WebGLRenderer,
  PerspectiveCamera,
  Mesh,
  PlaneGeometry,
  MeshBasicMaterial,
  BufferAttribute,
  CanvasTexture,
  FrontSide,
} from 'three';
import { gsap } from 'gsap';
import { TOOLBAR_HEIGHT } from './constants.js';

const LIFT_FACTOR = 0.45;

// Pre-normalized light direction — computed once, reused every vertex per frame.
const LIGHT = new Vector3(0.3, 0.5, 1.0).normalize();

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

    this._bookGroup = null;
    this._buildSceneDims = null; // page dims at the time of the last buildScene call

    this._init();
  }

  _init() {
    this._scene = new Scene();

    this._bookGroup = new Group();
    this._scene.add(this._bookGroup);

    this._renderer = new WebGLRenderer({ antialias: true, alpha: true });
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
    this._buildSceneDims = pageDims;
    this._layout = layout;
    this._currentLeftPage = currentLeftPage;
    this._totalPages = totalPages;

    const containerW = Math.max(1, this._container.clientWidth);
    const containerH = Math.max(1, this._container.clientHeight - TOOLBAR_HEIGHT);

    this._renderer.setSize(containerW, containerH);
    this._bookGroup.scale.set(1, 1, 1);

    // PerspectiveCamera calibrated so the scene at z=0 maps 1:1 to CSS pixels.
    // cameraZ = containerH gives ~53° vFOV — enough perspective that the
    // flipping page's Z arc reads as dramatic depth.
    const cameraZ = containerH;
    const fovY = 2 * Math.atan(containerH / 2 / cameraZ) * (180 / Math.PI);
    this._camera = new PerspectiveCamera(fovY, containerW / containerH, 0.1, cameraZ * 4);
    this._camera.position.set(0, 0, cameraZ);
    this._camera.lookAt(0, 0, 0);

    this._clearMeshes();
    this._bookGroup.position.x = this._getGroupOffsetX(currentLeftPage);
    this._buildPageMeshes(pageDims.pageWidth, pageDims.pageHeight, layout);
    this._updateTextures();
  }

  /**
   * Lightweight resize — updates the renderer, camera, and book group scale
   * without tearing down or rebuilding geometry. Use for pure container-size
   * changes where the layout (single/double) has not changed.
   */
  resize(newPageDims) {
    if (!this._camera || !this._renderer || !this._bookGroup) return;
    if (!newPageDims || newPageDims.pageHeight <= 0) return;

    const containerW = Math.max(1, this._container.clientWidth);
    const containerH = Math.max(1, this._container.clientHeight - TOOLBAR_HEIGHT);

    this._renderer.setSize(containerW, containerH);

    // Recalibrate camera (same formula as buildScene)
    const cameraZ = containerH;
    const fovY = 2 * Math.atan(containerH / 2 / cameraZ) * (180 / Math.PI);
    this._camera.fov = fovY;
    this._camera.aspect = containerW / containerH;
    this._camera.position.z = cameraZ;
    this._camera.far = cameraZ * 4;
    this._camera.updateProjectionMatrix();

    // Scale the book group so existing meshes fill the new container.
    // _pageDims intentionally stays as the original buildScene geometry dimensions
    // so that flip deformation (which uses pageW to index into original vertex
    // positions) and shadow placement (±pageW/2 in group-local space) remain
    // correct — the group-level scale makes them land in the right world position.
    // position.x (cover centring offset) is recomputed in geometry space and
    // then scaled to world space by the same factor.
    if (this._buildSceneDims && this._buildSceneDims.pageHeight > 0) {
      const scale = newPageDims.pageHeight / this._buildSceneDims.pageHeight;
      this._bookGroup.scale.set(scale, scale, scale);
      this._bookGroup.position.x = this._getGroupOffsetX(this._currentLeftPage) * scale;
    }
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
      this._bookGroup.remove(mesh);
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

    this._leftMesh = new Mesh(
      new PlaneGeometry(pageW, pageH),
      new MeshBasicMaterial({ color: 0xffffff })
    );
    this._leftMesh.position.set(isDouble ? -halfW : 0, 0, 0);
    this._bookGroup.add(this._leftMesh);

    if (isDouble) {
      this._rightMesh = new Mesh(
        new PlaneGeometry(pageW, pageH),
        new MeshBasicMaterial({ color: 0xffffff })
      );
      this._rightMesh.position.set(halfW, 0, 0);
      this._bookGroup.add(this._rightMesh);

      // ── Asymmetric spine shadow overlays ─────────────────────────────────
      // The left page bows up toward the spine in a real book, creating a
      // pronounced shadow as it curves down to meet the binding.
      // The right page lies relatively flat — little to no shadow there.

      // Left page — strong crease bow at spine (right edge of this page).
      // Gradient reversed to match UV direction: dark at u=0, transparent at u=1.
      const leftTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0)'],
        [0.40, 'rgba(0,0,0,0)'],
        [0.75, 'rgba(0,0,0,0.05)'],
        [0.90, 'rgba(0,0,0,0.10)'],
        [1.0,  'rgba(0,0,0,0.15)'],
      ]);
      this._leftOverlay = new Mesh(
        new PlaneGeometry(pageW, pageH),
        new MeshBasicMaterial({ map: leftTex, transparent: true, depthWrite: false })
      );
      this._leftOverlay.position.set(-halfW, 0, 0.2);
      this._bookGroup.add(this._leftOverlay);

      // Right page (u=0 = spine, u=1 = outer right edge) — nearly flat
      const rightTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0.15)'],
        [0.10, 'rgba(0,0,0,0.10)'],
        [0.25, 'rgba(0,0,0,0.05)'],
        [0.60, 'rgba(0,0,0,0)'],
        [1.0,  'rgba(0,0,0,0)'],
      ]);
      this._rightOverlay = new Mesh(
        new PlaneGeometry(pageW, pageH),
        new MeshBasicMaterial({ map: rightTex, transparent: true, depthWrite: false })
      );
      this._rightOverlay.position.set(halfW, 0, 0.2);
      this._bookGroup.add(this._rightOverlay);

      // Spine crease — asymmetric: shadow biased to left side where the left
      // page bows up to meet the binding; right side nearly clean.
      const spineTex = this._makeGradientTex([
        [0,    'rgba(0,0,0,0.00)'],
        [0.50, 'rgba(0,0,0,0.08)'],
        [0.51, 'rgba(0,0,0,0.0)'],
        [1.0,  'rgba(0,0,0,0)'],
      ]);
      this._spineMesh = new Mesh(
        new PlaneGeometry(pageW * 0.04, pageH),
        new MeshBasicMaterial({ map: spineTex, transparent: true, depthWrite: false })
      );
      this._spineMesh.position.set(0, 0, 0.5);
      this._bookGroup.add(this._spineMesh);
    }

    // ── Flip meshes ───────────────────────────────────────────────────────────

    const makeFlipGeo = (translateX) => {
      const g = new PlaneGeometry(pageW, pageH, 60, 10);
      g.translate(translateX, 0, 0);
      g.userData.originalPositions = g.attributes.position.array.slice();
      const n = g.attributes.position.count;
      g.setAttribute('color', new BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      return g;
    };

    this._flipRightMesh = new Mesh(
      makeFlipGeo(pageW / 2),
      new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: FrontSide })
    );
    this._flipRightMesh.position.set(0, 0, 2);
    this._flipRightMesh.visible = false;
    this._bookGroup.add(this._flipRightMesh);

    this._flipLeftMesh = new Mesh(
      makeFlipGeo(-pageW / 2),
      new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: FrontSide })
    );
    this._flipLeftMesh.position.set(0, 0, 2);
    this._flipLeftMesh.visible = false;
    this._bookGroup.add(this._flipLeftMesh);

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
    this._shadowMesh = new Mesh(
      new PlaneGeometry(pageW, pageH),
      new MeshBasicMaterial({
        map: this._shadowFwdTex, transparent: true, opacity: 0, depthWrite: false,
      })
    );
    this._shadowMesh.position.set(0, 0, 1); // below flip meshes (z=2) — cast shadow on the receiving page only
    this._bookGroup.add(this._shadowMesh);
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
    const tex = new CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }

  // ── Cover / back-cover helpers ────────────────────────────────────────────

  /** True when the book is showing page 1 alone (front cover, double mode). */
  _isCoverSpread(leftPage) {
    return this._layout === 'double' && leftPage === 1 && this._totalPages > 1;
  }

  /** True when the book is showing the last page alone (back cover, double mode, even total). */
  _isBackCoverSpread(leftPage) {
    return this._layout === 'double' && this._totalPages > 1 &&
           leftPage === this._totalPages && this._totalPages % 2 === 0;
  }

  /**
   * Returns the bookGroup x-offset so that a lone cover/back-cover page appears centred.
   * Cover  → shift group left by halfW  (rightMesh at +halfW within group → x=0 on screen)
   * BackCover → shift group right by halfW (leftMesh at -halfW within group → x=0 on screen)
   * Normal → no offset
   */
  _getGroupOffsetX(leftPage) {
    const hw = this._pageDims.pageWidth / 2;
    if (this._isCoverSpread(leftPage))     return -hw;
    if (this._isBackCoverSpread(leftPage)) return  hw;
    return 0;
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

  /** Ambient + diffuse shading against the pre-normalized module-level LIGHT. */
  _shade(nx, ny, nz) {
    const dot = nx * LIGHT.x + ny * LIGHT.y + nz * LIGHT.z;
    return 0.68 + 0.32 * Math.max(0, dot);
  }

  // ── Texture management ─────────────────────────────────────────────────────

  async _updateTextures() {
    if (!this._loader) return;
    const lp = this._currentLeftPage;
    const isCover     = this._isCoverSpread(lp);
    const isBackCover = this._isBackCoverSpread(lp);
    const isDouble    = this._layout === 'double';

    if (isCover) {
      // Front cover alone: page 1 on rightMesh, leftMesh hidden
      if (this._leftMesh)    this._leftMesh.visible    = false;
      if (this._leftOverlay) this._leftOverlay.visible = false;
      if (this._rightMesh) {
        this._rightMesh.visible = true;
        this._applyTexture(this._rightMesh, 1);
      }
      if (this._rightOverlay) this._rightOverlay.visible = false;
      if (this._spineMesh)    this._spineMesh.visible    = false;
    } else if (isBackCover) {
      // Back cover alone: last page on leftMesh, rightMesh hidden
      if (this._leftMesh) {
        this._leftMesh.visible = true;
        this._applyTexture(this._leftMesh, lp);
      }
      if (this._leftOverlay)  this._leftOverlay.visible  = true;
      if (this._rightMesh)    this._rightMesh.visible    = false;
      if (this._rightOverlay) this._rightOverlay.visible = false;
      if (this._spineMesh)    this._spineMesh.visible    = false;
    } else {
      // Normal spread
      if (this._leftMesh) {
        this._leftMesh.visible = true;
        this._applyTexture(this._leftMesh, lp);
      }
      if (this._leftOverlay)  this._leftOverlay.visible  = isDouble;
      if (this._rightOverlay) this._rightOverlay.visible = isDouble;
      if (this._spineMesh)    this._spineMesh.visible    = isDouble;
      if (isDouble && this._rightMesh) {
        this._rightMesh.visible = true;
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
    // Forward from cover: page 1 is on rightMesh, so the turning page IS page 1, not page 2.
    const currentIsCover  = this._isCoverSpread(this._currentLeftPage);
    const targetIsCover   = this._isCoverSpread(targetLeftPage);
    const targetIsBackCover = this._isBackCoverSpread(targetLeftPage);

    const turningPage = isForward
      ? (isDouble ? (currentIsCover ? this._currentLeftPage : this._currentLeftPage + 1) : this._currentLeftPage)
      : this._currentLeftPage;
    this._applyTexture(shrinkMesh, turningPage);

    // Backward to cover: cover is on the right side — backPage = 1 = targetLeftPage.
    const backPage = isForward
      ? targetLeftPage
      : (targetIsCover ? targetLeftPage : Math.min(targetLeftPage + 1, this._totalPages));
    growMesh.material.map = null;
    growMesh.material.color.set(0xffffff);
    this._applyTexture(growMesh, backPage);

    // Update the static mesh hidden behind the shrink mesh immediately.
    if (isForward) {
      if (isDouble && this._rightMesh) {
        if (targetIsBackCover) {
          // Going to back cover: rightMesh will be hidden, nothing to preload
          this._rightMesh.visible = false;
          if (this._rightOverlay) this._rightOverlay.visible = false;
        } else {
          this._rightMesh.visible = true;
          if (this._rightOverlay) this._rightOverlay.visible = true;
          const rp = targetLeftPage + 1;
          if (rp <= this._totalPages) {
            this._applyTexture(this._rightMesh, rp);
          } else {
            this._rightMesh.material.map = null;
            this._rightMesh.material.color.set(0xfafafa);
            this._rightMesh.material.needsUpdate = true;
          }
        }
      }
    } else {
      if (targetIsCover) {
        // Going backward to cover: leftMesh will be hidden in cover view
        if (this._leftMesh)    this._leftMesh.visible    = false;
        if (this._leftOverlay) this._leftOverlay.visible = false;
      } else {
        if (this._leftMesh) this._leftMesh.visible = true;
        this._applyTexture(this._leftMesh, targetLeftPage);
      }
    }

    // Position the cast shadow on the page the flip will land on.
    // Forward: shadow lands on left page; backward: on right page.
    // Each direction has its own gradient texture so the shadow always reads
    // dark near the spine and transparent toward the outer page edge.
    if (this._shadowMesh) {
      this._shadowMesh.position.x = isForward ? -(pageW / 2) : (pageW / 2);
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

    // Animate bookGroup x-offset in sync with the flip so a lone cover/back-cover
    // page slides smoothly to/from its centred position.
    const groupXEnd = this._getGroupOffsetX(targetLeftPage);

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

        // Restore correct mesh/overlay visibility for the target spread
        const tIsCover     = this._isCoverSpread(targetLeftPage);
        const tIsBackCover = this._isBackCoverSpread(targetLeftPage);
        if (this._leftMesh)     this._leftMesh.visible     = !tIsCover;
        if (this._rightMesh)    this._rightMesh.visible    = !tIsBackCover;
        if (this._leftOverlay)  this._leftOverlay.visible  = !tIsCover && isDouble;
        if (this._rightOverlay) this._rightOverlay.visible = !tIsBackCover && isDouble;
        if (this._spineMesh)    this._spineMesh.visible    = !tIsCover && !tIsBackCover && isDouble;

        if (this._onPageChangeCb) this._onPageChangeCb(targetLeftPage);
        if (this._loader) this._loader.prefetch(targetLeftPage, this._totalPages);
        this._processQueue();
      },
    });

    // Slide the whole book group to centre a lone cover/back-cover page
    if (this._bookGroup.position.x !== groupXEnd) {
      this._currentTimeline.to(
        this._bookGroup.position,
        { x: groupXEnd, duration: duration / 1000, ease: 'power2.inOut' },
        0
      );
    }

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
    }, 0); // position 0 = runs in parallel with the group slide
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
    if (this._onAnimationEndCb) this._onAnimationEndCb();
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
