////////////////////////////////////////////////////////////
// chaseBoard3d.js — the Lift X efoil, drawn in chase view.
//
// assets/board/efoil.glb is baked so its origin is the wing under the mast,
// +Z is the nose, +Y is up, and 1 unit is 1 metre at the 2× chase scale:
// a 1.60 × 0.60 m deck, 85 cm from its underside to the wing, and a 45 cm
// front wing. The part below the water is clipped.
////////////////////////////////////////////////////////////

import * as THREE from './lib/three/three.module.min.js';
import { depthAt, projectHeight } from './chaseCam.js';

const MODEL_URL = new URL('./assets/board/efoil.glb', import.meta.url);

let gl = null;
let failed = false;
let craft = null;
let loading = null;

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
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c4cc, 2.7));
    const sun = new THREE.DirectionalLight(0xfff8ee, 1.6);
    sun.position.set(0.35, -0.15, 0.92);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera();
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;

    const water = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      gl = null;
    });
    gl = { canvas, renderer, scene, camera, water, bufW: 0, bufH: 0 };
    return gl;
  } catch (err) {
    console.warn('Chase board: WebGL unavailable', err);
    failed = true;
    return null;
  }
}

function accessorArray(json, bin, index) {
  const a = json.accessors[index];
  const view = json.bufferViews[a.bufferView];
  const start = (view.byteOffset || 0) + (a.byteOffset || 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const width = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType];
  const stride = view.byteStride || comps * width;
  const count = a.count;
  const aligned = (bin.byteOffset + start) % width === 0;
  if (aligned && a.componentType === 5126 && stride === comps * 4) {
    return new Float32Array(bin.buffer, bin.byteOffset + start, count * comps);
  }
  if (aligned && a.componentType === 5123 && comps === 1 && stride === 2) {
    return new Uint16Array(bin.buffer, bin.byteOffset + start, count);
  }
  if (aligned && a.componentType === 5125 && comps === 1 && stride === 4) {
    return new Uint32Array(bin.buffer, bin.byteOffset + start, count);
  }
  if (aligned && a.componentType === 5121 && comps === 1 && stride === 1) {
    return new Uint8Array(bin.buffer, bin.byteOffset + start, count);
  }
  const out = a.componentType === 5126
    ? new Float32Array(count * comps)
    : a.componentType === 5125
      ? new Uint32Array(count * comps)
      : a.componentType === 5123
        ? new Uint16Array(count * comps)
        : new Uint8Array(count * comps);
  const dv = new DataView(bin.buffer, bin.byteOffset + start, view.byteLength - (a.byteOffset || 0));
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < comps; k++) {
      const o = i * stride + k * width;
      if (a.componentType === 5126) out[i * comps + k] = dv.getFloat32(o, true);
      else if (a.componentType === 5125) out[i * comps + k] = dv.getUint32(o, true);
      else if (a.componentType === 5123) out[i * comps + k] = dv.getUint16(o, true);
      else out[i * comps + k] = dv.getUint8(o);
    }
  }
  return out;
}

function materialFor(json, bin, textures, index, water) {
  const src = json.materials[index] || {};
  const pbr = src.pbrMetallicRoughness || {};
  const color = pbr.baseColorFactor || [1, 1, 1, 1];
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color[0], color[1], color[2]),
    metalness: pbr.metallicFactor != null ? pbr.metallicFactor : 1,
    roughness: pbr.roughnessFactor != null ? pbr.roughnessFactor : 1,
    side: src.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    clippingPlanes: water
  });
  // A metallic paint with no sky to reflect reads as black. Keep the colour
  // the scan authored and let the hemisphere light show it.
  mat.metalness = Math.min(mat.metalness, 0.45);
  mat.roughness = Math.max(mat.roughness, 0.35);
  const texInfo = pbr.baseColorTexture;
  if (texInfo && textures[texInfo.index]) mat.map = textures[texInfo.index];
  mat.userData.baseColor = mat.color.clone();
  return mat;
}

function buildMesh(json, bin, textures, water) {
  const materials = json.materials.map((_, i) => materialFor(json, bin, textures, i, water));
  const root = new THREE.Group();
  root.matrixAutoUpdate = false;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const grow = (arr) => {
    for (let i = 0; i < arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], arr[i + k]);
        max[k] = Math.max(max[k], arr[i + k]);
      }
    }
  };
  for (const meshDef of json.meshes) {
    for (const prim of meshDef.primitives) {
      if (prim.mode != null && prim.mode !== 4) continue;
      const pos = accessorArray(json, bin, prim.attributes.POSITION);
      grow(pos);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (prim.attributes.NORMAL != null) {
        geo.setAttribute('normal', new THREE.BufferAttribute(accessorArray(json, bin, prim.attributes.NORMAL), 3));
      } else geo.computeVertexNormals();
      if (prim.attributes.TEXCOORD_0 != null) {
        geo.setAttribute('uv', new THREE.BufferAttribute(accessorArray(json, bin, prim.attributes.TEXCOORD_0), 2));
      }
      if (prim.indices != null) geo.setIndex(new THREE.BufferAttribute(accessorArray(json, bin, prim.indices), 1));
      const mat = materials[prim.material] || materials[0];
      const mesh = new THREE.Mesh(geo, mat);
      mesh.matrixAutoUpdate = false;
      root.add(mesh);
    }
  }
  const ghost = new THREE.Group();
  ghost.matrixAutoUpdate = false;
  const pink = new THREE.Color(0xff88ff);
  for (const child of root.children) {
    const src = child.material;
    const mat = src.clone();
    mat.color.copy(src.userData.baseColor).lerp(pink, 0.82);
    mat.emissive.copy(pink).multiplyScalar(0.15);
    ghost.add(new THREE.Mesh(child.geometry, mat));
  }
  return { root, ghost, min, max };
}

function loadTextures(json, bin) {
  const textures = new Array(json.textures ? json.textures.length : 0);
  const pending = [];
  for (let i = 0; i < textures.length; i++) {
    const texDef = json.textures[i];
    const image = json.images[texDef.source];
    const view = json.bufferViews[image.bufferView];
    const start = view.byteOffset || 0;
    const bytes = bin.slice(start, start + view.byteLength);
    const blob = new Blob([bytes], { type: image.mimeType || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const tex = new THREE.Texture();
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.flipY = false;
    textures[i] = tex;
    pending.push(new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        tex.image = img;
        tex.needsUpdate = true;
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => resolve();
      img.src = url;
    }));
  }
  return { textures, pending };
}

function loadModel() {
  if (craft || failed) return Promise.resolve(craft);
  if (loading) return loading;
  if (!setup()) return Promise.resolve(null);
  loading = fetch(MODEL_URL)
    .then((res) => {
      if (!res.ok) throw new Error('board model ' + res.status);
      return res.arrayBuffer();
    })
    .then((buffer) => {
      const data = new Uint8Array(buffer);
      const jsonLen = new DataView(buffer).getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(data.subarray(20, 20 + jsonLen)));
      const binStart = 20 + jsonLen + 8;
      const bin = data.subarray(binStart);
      const { textures, pending } = loadTextures(json, bin);
      craft = buildMesh(json, bin, textures, gl.water);
      gl.scene.add(craft.root);
      gl.scene.add(craft.ghost);
      craft.root.visible = false;
      craft.ghost.visible = false;
      return Promise.all(pending).then(() => craft);
    })
    .catch((err) => {
      console.warn('Chase board: model failed to load', err);
      failed = true;
      craft = null;
      return null;
    });
  return loading;
}

loadModel();

function setCamera(cam, x0, y0, bw, bh, near, far) {
  const { camera } = gl;
  const ex = cam.eyeX;
  const ey = -cam.eyeY;
  const ez = cam.eyeZ;
  const r = [cam.r3[0], -cam.r3[1], cam.r3[2]];
  const u = [cam.u3[0], -cam.u3[1], cam.u3[2]];
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

// Model metres (X right, Y up, Z nose) to the chase scene (X right, Y north, Z up).
function place(group, pose, ppm) {
  const H = pose.heading;
  const roll = pose.roll || 0;
  const cosH = Math.cos(H);
  const sinH = Math.sin(H);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);
  const k = ppm;
  // Positive roll lowers the right rail.
  const rx = -sinH * cosR;
  const ry = -cosH * cosR;
  const rz = -sinR;
  const ux = -sinH * sinR;
  const uy = -cosH * sinR;
  const uz = cosR;
  const fx = cosH;
  const fy = -sinH;
  const side = (pose.wingSideM || 0) * k;
  const tx = pose.x - sinH * side;
  const ty = -(pose.y + cosH * side);
  const tz = (pose.wingZM || 0) * k;
  group.matrix.set(
    rx * k, ux * k, fx * k, tx,
    ry * k, uy * k, fy * k, ty,
    rz * k, uz * k, 0, tz,
    0, 0, 0, 1
  );
  group.matrixWorldNeedsUpdate = true;
}

function scenePoint(pose, ppm, x, y, z) {
  const H = pose.heading;
  const roll = pose.roll || 0;
  const cosH = Math.cos(H);
  const sinH = Math.sin(H);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);
  const xr = x * cosR + y * sinR;
  const yr = -x * sinR + y * cosR;
  const side = pose.wingSideM || 0;
  return {
    x: pose.x + (-sinH * (xr + side) + cosH * z) * ppm,
    y: pose.y + (cosH * (xr + side) + sinH * z) * ppm,
    z: (yr + (pose.wingZM || 0)) * ppm
  };
}

function screenBox(cam, pose, ppm) {
  const { min, max } = craft;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  let behind = false;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const p = scenePoint(pose, ppm, x, y, z);
        minD = Math.min(minD, depthAt(cam, p.x, p.y, p.z));
        maxD = Math.max(maxD, depthAt(cam, p.x, p.y, p.z));
        const s = projectHeight(cam, p.x, p.y, p.z);
        if (!s) {
          behind = true;
          continue;
        }
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
      }
    }
  }
  if (!(maxD > 1)) return null;
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

function renderJob(cam, job, ppm) {
  const { renderer } = gl;
  const { box, pose, vw, vh } = job;
  const near = box.minD > 2 ? box.minD * 0.85 : Math.max(0.5, 0.04 * ppm);
  const far = Math.max(near * 4, box.maxD * 1.15 + 4);
  setCamera(cam, box.x0, box.y0, box.bw, box.bh, near, far);
  const group = pose.ghost ? craft.ghost : craft.root;
  craft.root.visible = group === craft.root;
  craft.ghost.visible = group === craft.ghost;
  place(group, pose, ppm);
  const glY = gl.bufH - job.sy - vh;
  renderer.setViewport(job.sx, glY, vw, vh);
  renderer.setScissor(job.sx, glY, vw, vh);
  renderer.setScissorTest(true);
  renderer.render(gl.scene, gl.camera);
}

/**
 * Draw scanned boards into `ctx` (screen space). Each pose is
 * `{ x, y, heading, roll, wingSideM, wingZM, alpha, ghost }` with x/y in
 * world pixels and the wing offsets in metres. Returns false until the
 * model is ready, so the caller can keep the flat board.
 */
export function drawChaseBoards(ctx, cam, list, ppm) {
  if (!setup() || !craft) {
    loadModel();
    return false;
  }
  const { renderer } = gl;
  const maxSide = Math.min(4096, renderer.capabilities.maxTextureSize || 4096);
  const jobs = list
    .filter(pose => !(pose.alpha <= 0.001))
    .map(pose => ({ pose, box: screenBox(cam, pose, ppm) }))
    .filter(job => job.box);
  if (!jobs.length) return false;

  let width = 0;
  for (const job of jobs) {
    const area = job.box.bw * job.box.bh;
    const ss = area < 50000 ? 2 : 1;
    job.vw = Math.min(maxSide, Math.ceil(job.box.bw * ss));
    job.vh = Math.min(maxSide, Math.ceil(job.box.bh * ss));
    width = Math.max(width, job.vw);
  }
  let x = 0;
  let y = 0;
  let row = 0;
  for (const job of jobs) {
    if (x > 0 && x + job.vw > maxSide) {
      x = 0;
      y += row;
      row = 0;
    }
    job.sx = x;
    job.sy = y;
    x += job.vw;
    row = Math.max(row, job.vh);
  }
  width = Math.min(maxSide, Math.max(width, x));
  const height = Math.min(maxSide, y + row);

  const needW = Math.min(maxSide, Math.ceil(width / 256) * 256);
  const needH = Math.min(maxSide, Math.ceil(height / 256) * 256);
  const grow = needW > gl.bufW || needH > gl.bufH;
  const shrink = gl.bufW * gl.bufH > 4 * needW * needH;
  if (grow || shrink) {
    gl.bufW = shrink ? needW : Math.max(gl.bufW, needW);
    gl.bufH = shrink ? needH : Math.max(gl.bufH, needH);
    renderer.setSize(gl.bufW, gl.bufH, false);
  }

  for (const job of jobs) renderJob(cam, job, ppm);
  craft.root.visible = false;
  craft.ghost.visible = false;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const baseAlpha = ctx.globalAlpha;
  for (const job of jobs) {
    if (job.sy + job.vh > gl.bufH || job.sx + job.vw > gl.bufW) continue;
    ctx.globalAlpha = baseAlpha * (job.pose.alpha != null ? job.pose.alpha : 1);
    ctx.drawImage(gl.canvas, job.sx, job.sy, job.vw, job.vh, job.box.x0, job.box.y0, job.box.bw, job.box.bh);
  }
  ctx.restore();
  return true;
}
