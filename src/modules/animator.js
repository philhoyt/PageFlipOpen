/**
 * animator.js — 3D Flip Animation
 * Owns the Three.js scene, camera, renderer, and GSAP flip queue.
 *
 * Page turn technique: spine-pivot scale animation.
 *
 * Two half-page meshes share the same spine-pivot geometry
 * (PlaneGeometry translated so its LEFT edge sits at x=0, the spine).
 * Animating mesh.scale.x is equivalent to pivoting the page around the spine:
 *
 *   Forward flip (right page turns left):
 *     shrinkMesh: scale.x  1 → 0   (right page collapses toward spine)
 *     growMesh:   scale.x  0 → -1  (back of page expands leftward)
 *
 *   Backward flip (left page turns right):
 *     shrinkMesh: scale.x -1 → 0   (left page collapses toward spine)
 *     growMesh:   scale.x  0 → 1   (back of page expands rightward)
 *
 * Both meshes use THREE.DoubleSide so they stay visible regardless of scale sign.
 */

import * as THREE from 'three';
import { gsap } from 'gsap';

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
    this._spineMesh = null;

    // Flip meshes (right/left refer to which side of the spine they occupy)
    this._flipRightMesh = null;  // spans [0, pageW]  — pivot at spine, extends right
    this._flipLeftMesh = null;   // spans [-pageW, 0] — pivot at spine, extends left

    // Shadow
    this._shadowMesh = null;

    // GSAP queue
    this._flipQueue = [];
    this._currentTimeline = null;
    this._isAnimating = false;

    this._onPageChangeCb = null;
    this._onAnimationEndCb = null;
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
  onPageChange(cb) { this._onPageChangeCb = cb; }
  onAnimationEnd(cb) { this._onAnimationEndCb = cb; }

  buildScene(pageDims, layout, currentLeftPage, totalPages) {
    this._pageDims = pageDims;
    this._layout = layout;
    this._currentLeftPage = currentLeftPage;
    this._totalPages = totalPages;

    const containerW = this._container.clientWidth;
    const containerH = this._container.clientHeight - 44; // subtract toolbar

    this._renderer.setSize(containerW, containerH);

    // Camera frustum = renderer canvas exactly (1 world unit = 1 pixel).
    // This guarantees no aspect-ratio distortion regardless of spread size.
    // Page geometry dimensions come from layout.js already in pixel units.
    this._camera = new THREE.OrthographicCamera(
      -containerW / 2,  containerW / 2,
       containerH / 2, -containerH / 2,
      0.1, 1000
    );
    this._camera.position.set(0, 0, 100);
    this._camera.lookAt(0, 0, 0);

    this._clearMeshes();
    this._buildPageMeshes(pageDims.pageWidth, pageDims.pageHeight, layout);
    this._updateTextures();
  }

  _clearMeshes() {
    const meshes = [
      this._leftMesh, this._rightMesh, this._spineMesh,
      this._flipRightMesh, this._flipLeftMesh, this._shadowMesh,
    ];
    for (const mesh of meshes) {
      if (!mesh) continue;
      this._scene.remove(mesh);
      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(m => m.dispose());
      } else {
        mesh.material.dispose();
      }
    }
    this._leftMesh = null;
    this._rightMesh = null;
    this._spineMesh = null;
    this._flipRightMesh = null;
    this._flipLeftMesh = null;
    this._shadowMesh = null;
  }

  _buildPageMeshes(pageW, pageH, layout) {
    const isDouble = layout === 'double';
    const halfW = pageW / 2;

    // ── Static page meshes ────────────────────────────────────────────────────
    // MeshBasicMaterial renders textures at full brightness (no lighting math).

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

      // Thin spine shadow strip
      this._spineMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(6, pageH),
        new THREE.MeshBasicMaterial({
          color: 0x000000, transparent: true, opacity: 0.2, depthWrite: false,
        })
      );
      this._spineMesh.position.set(0, 0, 0.5);
      this._scene.add(this._spineMesh);
    }

    // ── Flip meshes ───────────────────────────────────────────────────────────
    // Two distinct geometries — one for each side of the spine — so scale.x
    // is always positive and textures are never mirrored.
    //
    //  _flipRightMesh: spans [0, pageW]  — right side of spine
    //    scale.x: 1→0  forward shrink (right page collapsing)
    //    scale.x: 0→1  backward grow  (back face expanding rightward)
    //
    //  _flipLeftMesh:  spans [-pageW, 0] — left side of spine
    //    scale.x: 0→1  forward grow   (back face expanding leftward)
    //    scale.x: 1→0  backward shrink (left page collapsing)

    const makeRightGeo = () => {
      const g = new THREE.PlaneGeometry(pageW, pageH);
      g.translate(pageW / 2, 0, 0);   // spans [0, pageW]
      return g;
    };
    const makeLeftGeo = () => {
      const g = new THREE.PlaneGeometry(pageW, pageH);
      g.translate(-pageW / 2, 0, 0);  // spans [-pageW, 0]
      return g;
    };

    this._flipRightMesh = new THREE.Mesh(
      makeRightGeo(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide })
    );
    this._flipRightMesh.position.set(0, 0, 2);
    this._flipRightMesh.visible = false;
    this._scene.add(this._flipRightMesh);

    this._flipLeftMesh = new THREE.Mesh(
      makeLeftGeo(),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.FrontSide })
    );
    this._flipLeftMesh.position.set(0, 0, 2);
    this._flipLeftMesh.visible = false;
    this._scene.add(this._flipLeftMesh);

    // Shadow strip that follows the fold crease
    this._shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(pageW * 0.35, pageH),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0, depthWrite: false,
      })
    );
    this._shadowMesh.position.set(0, 0, 1.5);
    this._scene.add(this._shadowMesh);
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
    const isDouble = this._layout === 'double';
    const isForward = direction === 'forward';
    const pageW = this._pageDims.pageWidth;

    // Max Z lift at the midpoint of the animation (simulates the page curling off the surface)
    const LIFT = pageW * 0.15;

    // forward: right page turns left  → shrink = _flipRightMesh, grow = _flipLeftMesh
    // backward: left page turns right → shrink = _flipLeftMesh,  grow = _flipRightMesh
    const shrinkMesh = isForward ? this._flipRightMesh : this._flipLeftMesh;
    const growMesh   = isForward ? this._flipLeftMesh  : this._flipRightMesh;

    // Page that's physically turning
    const turningPage = isForward
      ? (isDouble ? this._currentLeftPage + 1 : this._currentLeftPage)
      : this._currentLeftPage;
    this._applyTexture(shrinkMesh, turningPage);

    // Back of the turning page = incoming page on the side it's landing
    const backPage = isForward
      ? targetLeftPage
      : Math.min(targetLeftPage + 1, this._totalPages);
    growMesh.material.map = null;
    growMesh.material.color.set(0xffffff);
    this._applyTexture(growMesh, backPage);

    // Update the static mesh on the side the shrink mesh covers immediately —
    // it's invisible behind the shrink mesh throughout phase 1.
    // The other side stays on current content; its texture is transferred
    // synchronously from the grow mesh in onComplete (see below).
    if (isForward) {
      // Right static is covered by shrink mesh — update it now
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
      // Left static is covered by shrink mesh — update it now
      this._applyTexture(this._leftMesh, targetLeftPage);
    }

    // Initial state
    shrinkMesh.scale.x = 1;
    shrinkMesh.position.z = 2;
    shrinkMesh.visible = true;
    growMesh.scale.x = 0;
    growMesh.position.z = 2;
    growMesh.visible = false;

    if (this._shadowMesh) this._shadowMesh.material.opacity = 0;

    const prog = { t: 0 };

    this._currentTimeline = gsap.timeline({
      onComplete: () => {
        this._currentLeftPage = targetLeftPage;
        if (this._shadowMesh) this._shadowMesh.material.opacity = 0;

        // At this point the grow mesh is at scale.x = 1, fully covering its side.
        // Synchronously copy its texture to the underlying static mesh before
        // hiding it — the swap is invisible and requires no async texture load.
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
        growMesh.visible = false;

        // Re-apply all textures to ensure full correctness (handles edge cases)
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
        const arcZ = 2 + Math.sin(t * Math.PI) * LIFT;

        if (t <= 0.5) {
          // Phase 1: source page collapses toward spine
          shrinkMesh.scale.x = 1 - t * 2;
          shrinkMesh.position.z = arcZ;
          shrinkMesh.visible = true;
          growMesh.visible = false;
        } else {
          // Phase 2: back face expands from spine to destination
          growMesh.scale.x = (t - 0.5) * 2;
          growMesh.position.z = arcZ;
          shrinkMesh.visible = false;
          growMesh.visible = true;
        }

        // Shadow follows the fold crease, peaks at t=0.5
        if (this._shadowMesh) {
          const creaseX = isForward
            ? pageW * (1 - t)    // right edge → spine
            : -pageW * (1 - t);  // left edge  → spine
          this._shadowMesh.position.x = isForward
            ? creaseX - pageW * 0.175
            : creaseX + pageW * 0.175;
          this._shadowMesh.position.z = 1.5;
          this._shadowMesh.material.opacity = Math.sin(t * Math.PI) * 0.3;
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
    if (this._flipLeftMesh) this._flipLeftMesh.visible = false;
    if (this._shadowMesh) this._shadowMesh.material.opacity = 0;
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
