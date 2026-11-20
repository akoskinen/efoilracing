////////////////////////////////////////////////////////////
// chaseBuoys3d.js — chase-view turn buoys drawn with three.js.
// Geometry lives in inflatedTetraBuoy.js. Each buoy renders on the GPU to
// an offscreen canvas cropped to the area it covers, which is copied into
// the 2D canvas where the buoys belong in the draw order, so racing lines,
// numbers, the board and the HUD stack exactly as before.
////////////////////////////////////////////////////////////

import * as THREE from './lib/three/three.module.min.js';
import { depthAt, projectClipped } from './chaseCam.js';
import { buildInflatedTetra } from './inflatedTetraBuoy.js';

/** Tip height above the water, in meters. */
export const INFLATABLE_HEIGHT_M = 1.5;

const SEGMENTS = 40;
const VINYL = 0xf6f8ff;
const PANEL_TEX = 1024;
const MAX_SUPERSAMPLED_PX = 2.5e6;

let gl = null;
let failed = false;
let shape = null;

function buildShape() {
  if (shape) return shape;
  const geom = buildInflatedTetra({ segments: SEGMENTS });
  const visible = geom.height - geom.suggestedDraft;
  const scale = INFLATABLE_HEIGHT_M / visible;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(geom.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(geom.normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(geom.uvs, 2));
  g.setIndex(new THREE.BufferAttribute(geom.indices, 1));
  for (const gr of geom.groups) g.addGroup(gr.start, gr.count, gr.kind === 'side' ? 0 : 1);
  g.computeBoundingSphere();

  const n = SEGMENTS;
  const vertsPer = ((n + 1) * (n + 2)) / 2;
  let nx = 0;
  let nz = 0;
  for (let k = 0; k < vertsPer; k++) {
    nx += geom.normals[k * 3];
    nz += geom.normals[k * 3 + 2];
  }
  shape = {
    geometry: g,
    scale,
    draft: geom.suggestedDraft * scale,
    height: geom.height * scale,
    // Half-width of a box that holds the puffed hull, in meters.
    reach: geom.edge * scale * 0.72,
    faceAz: Math.atan2(nz, nx),
    edge: geom.edge * scale,
    logo: logoRect(geom)
  };
  return shape;
}

function logoRect(geom) {
  const slantOverEdge = geom.slant / geom.edge;
  const logoCenterV = 0.34;
  const aspect = 396 / 166;
  // The clamp keeps the plate inside the panel's triangle if the aspect changes.
  const k = 1 / (2 * aspect * slantOverEdge);
  const margin = 0.05;
  const logoWidth = Math.min(0.40, (1 - logoCenterV - margin * 2) / (1 + k));
  const vHalf = logoWidth * k;
  return {
    u0: 0.5 - logoWidth / 2,
    u1: 0.5 + logoWidth / 2,
    v0: logoCenterV - vHalf,
    v1: logoCenterV + vHalf
  };
}

// One texture covers a side panel's whole UV square: white vinyl with the
// SFT plate printed where the old flat card sat.
function panelTexture(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL_TEX;
  canvas.height = PANEL_TEX;
  const c2 = canvas.getContext('2d');
  c2.fillStyle = '#fff';
  c2.fillRect(0, 0, PANEL_TEX, PANEL_TEX);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const box = buildShape().logo;
    // Texture v runs up the panel and the image's top row is the high-v edge.
    c2.imageSmoothingEnabled = true;
    c2.imageSmoothingQuality = 'high';
    c2.drawImage(
      img,
      box.u0 * PANEL_TEX,
      (1 - box.v1) * PANEL_TEX,
      (box.u1 - box.u0) * PANEL_TEX,
      (box.v1 - box.v0) * PANEL_TEX
    );
    tex.needsUpdate = true;
  };
  img.src = new URL('./assets/buoy/sft.png', import.meta.url).href;
  return tex;
}

function setup() {
  if (gl || failed) return gl;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      premultipliedAlpha: true
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;

    const scene = new THREE.Scene();
    // Physically based light levels: about π is full white on a lit face. The
    // ground colour stands in for light bounced off the water.
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4cc, 2.7));
    // Fixed sun. A light that followed the camera made each facet flash as
    // the rider turned around the buoy.
    const sun = new THREE.DirectionalLight(0xfff8ee, 1.5);
    sun.position.set(0.28, 0.18, 0.94);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;

    const water = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
    const map = panelTexture(renderer);
    const makeMaterials = () => [
      new THREE.MeshStandardMaterial({ color: VINYL, map, roughness: 0.5, metalness: 0, clippingPlanes: water }),
      new THREE.MeshStandardMaterial({ color: VINYL, roughness: 0.5, metalness: 0, clippingPlanes: water })
    ];

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      gl = null;
    });

    gl = { canvas, renderer, scene, camera, makeMaterials, mesh: null, bufW: 0, bufH: 0 };
    return gl;
  }
  catch (err) {
    console.warn('Chase buoys: WebGL unavailable', err);
    failed = true;
    return null;
  }
}

/** False when WebGL is missing, so the caller can draw flat marks instead. */
export function chaseBuoysAvailable() {
  return !!setup();
}

function hullMesh() {
  if (!gl.mesh) {
    gl.mesh = new THREE.Mesh(buildShape().geometry, gl.makeMaterials());
    gl.mesh.matrixAutoUpdate = false;
    gl.scene.add(gl.mesh);
  }
  return gl.mesh;
}

// The scene uses world pixels with y flipped (x right, y north, z up), which
// is right-handed, so the hull's outward winding and normals stay correct.
function placeMesh(mesh, b, ppm) {
  const s = buildShape();
  const yaw = (b.facing || 0) - s.faceAz;
  const c = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const k = s.scale * ppm;
  mesh.matrix.set(
    c * k, 0, -sn * k, b.x,
    -sn * k, 0, -c * k, -b.y,
    0, k, 0, -s.draft * ppm,
    0, 0, 0, 1
  );
  mesh.matrixWorldNeedsUpdate = true;
}

function setCamera(cam, x0, y0, bw, bh, near, far) {
  const { camera } = gl;
  const ex = cam.eyeX;
  const ey = -cam.eyeY;
  const ez = cam.eyeZ;
  const r = [cam.rx, -cam.ry, 0];
  const u = [cam.fx * cam.cp, -cam.fy * cam.cp, cam.sp];
  const back = [-cam.fx * cam.sp, cam.fy * cam.sp, cam.cp];
  const t = (v) => -(v[0] * ex + v[1] * ey + v[2] * ez);
  camera.matrixWorldInverse.set(
    r[0], r[1], r[2], t(r),
    u[0], u[1], u[2], t(u),
    back[0], back[1], back[2], t(back),
    0, 0, 0, 1
  );
  camera.matrixWorld.copy(camera.matrixWorldInverse).invert();
  camera.matrix.copy(camera.matrixWorld);
  // Same pinhole as chaseCam.js, cropped to the box the buoys cover.
  const a = 2 * cam.f / bw;
  const bx = 2 * (cam.cx - x0) / bw - 1;
  const cy = 2 * cam.f / bh;
  const by = 1 - 2 * (cam.cy - y0) / bh;
  camera.projectionMatrix.set(
    a, 0, -bx, 0,
    0, cy, -by, 0,
    0, 0, -(far + near) / (far - near), -2 * far * near / (far - near),
    0, 0, -1, 0
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function screenBox(cam, list, ppm) {
  const s = buildShape();
  const rad = s.reach * ppm;
  const top = (s.height - s.draft) * ppm;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  let behind = false;
  for (const b of list) {
    for (const dx of [-rad, rad]) {
      for (const dy of [-rad, rad]) {
        for (const z of [0, top]) {
          const x = b.x + dx;
          const y = b.y + dy;
          const d = depthAt(cam, x, y, z);
          minD = Math.min(minD, d);
          maxD = Math.max(maxD, d);
          if (d < 1) {
            behind = true;
            continue;
          }
          const sx = cam.cx + cam.f * ((x - cam.eyeX) * cam.rx + (y - cam.eyeY) * cam.ry) / d;
          const along = (x - cam.eyeX) * cam.fx + (y - cam.eyeY) * cam.fy;
          const sy = cam.cy - cam.f * (along * cam.cp + (z - cam.eyeZ) * cam.sp) / d;
          minX = Math.min(minX, sx);
          maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy);
          maxY = Math.max(maxY, sy);
        }
      }
    }
  }
  if (!(maxD > 1)) return null;
  // A box corner behind the eye has no screen point, so the hull may reach
  // any edge of the view.
  if (behind) {
    minX = 0;
    minY = 0;
    maxX = cam.viewW;
    maxY = cam.viewH;
  }
  const x0 = Math.max(0, Math.floor(minX) - 2);
  const y0 = Math.max(0, Math.floor(minY) - 2);
  const x1 = Math.min(cam.viewW, Math.ceil(maxX) + 2);
  const y1 = Math.min(cam.viewH, Math.ceil(maxY) + 2);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x0, y0, bw: x1 - x0, bh: y1 - y0, minD, maxD };
}

function drawShadow(ctx, cam, b, ppm) {
  const rad = 0.34 * buildShape().edge * ppm;
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push({ x: b.x + Math.cos(a) * rad, y: b.y + Math.sin(a) * rad, z: 0 });
  }
  const poly = projectClipped(cam, pts);
  if (!poly) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();
}

function drawOne(ctx, cam, b, ppm) {
  const box = screenBox(cam, [b], ppm);
  if (!box) return;
  const { renderer } = gl;
  const maxSide = Math.min(4096, renderer.capabilities.maxTextureSize || 4096);
  // Each buoy gets as many samples per pixel as the budget allows on top of
  // MSAA, so one a few pixels tall does not snap its outline and plate from
  // pixel to pixel as the camera drifts. Rendering buoys one at a time keeps
  // a close buoy from lowering that for the far ones.
  let ss = 1;
  for (const k of [8, 6, 4, 3, 2]) {
    if (box.bw * box.bh * k * k <= MAX_SUPERSAMPLED_PX) { ss = k; break; }
  }
  if (box.bw * ss > maxSide || box.bh * ss > maxSide) ss = 1;
  const vw = Math.min(maxSide, Math.ceil(box.bw * ss));
  const vh = Math.min(maxSide, Math.ceil(box.bh * ss));
  if (vw > gl.bufW || vh > gl.bufH) {
    gl.bufW = Math.min(maxSide, Math.max(gl.bufW, Math.ceil(vw / 256) * 256));
    gl.bufH = Math.min(maxSide, Math.max(gl.bufH, Math.ceil(vh / 256) * 256));
    renderer.setSize(gl.bufW, gl.bufH, false);
  }

  // The tightest near plane that still holds the hull keeps the depth
  // buffer's precision on the buoy, not on empty space in front of the eye.
  const near = box.minD > 2 ? box.minD * 0.9 : Math.max(0.5, 0.05 * ppm);
  const far = Math.max(near * 4, box.maxD * 1.1 + 4);
  setCamera(cam, box.x0, box.y0, box.bw, box.bh, near, far);
  placeMesh(hullMesh(), b, ppm);

  renderer.setViewport(0, 0, vw, vh);
  renderer.setScissor(0, 0, vw, vh);
  renderer.setScissorTest(true);
  renderer.render(gl.scene, gl.camera);

  ctx.save();
  if (b.alpha != null) ctx.globalAlpha *= b.alpha;
  drawShadow(ctx, cam, b, ppm);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(gl.canvas, 0, gl.bufH - vh, vw, vh, box.x0, box.y0, box.bw, box.bh);
  ctx.restore();
}

/**
 * Draw every chase-view turn buoy into `ctx` (screen space, identity
 * transform), far to near. Items are `{ x, y, facing, alpha }` in world
 * pixels; `facing` aims one panel at the course. Returns false when WebGL
 * is unavailable.
 */
export function drawChaseBuoys(ctx, cam, list, ppm) {
  if (!setup()) return false;
  list
    .filter(b => !(b.alpha <= 0.001))
    .map(b => ({ b, d: depthAt(cam, b.x, b.y, 0) }))
    .sort((p, q) => q.d - p.d)
    .forEach(({ b }) => drawOne(ctx, cam, b, ppm));
  return true;
}
