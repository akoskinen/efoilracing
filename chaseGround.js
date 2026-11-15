////////////////////////////////////////////////////////////
// chaseGround.js — Esri tiles on the water plane when the camera is tilted.
// Positions are camera-relative so city-scale mercator pixels stay precise.
////////////////////////////////////////////////////////////

import { viewDepth } from './chaseCam.js';

const VERT = `
attribute vec2 a_delta;
attribute vec2 a_uv;
uniform float u_eyeZ;
uniform vec2 u_f;
uniform vec2 u_r;
uniform float u_sp;
uniform float u_cp;
uniform float u_focal;
uniform vec2 u_view;
varying vec2 v_uv;
void main() {
  float dx = a_delta.x;
  float dy = a_delta.y;
  float dz = -u_eyeZ;
  float vx = dx * u_r.x + dy * u_r.y;
  float vu = (dx * u_f.x + dy * u_f.y) * u_cp + dz * u_sp;
  float vd = (dx * u_f.x + dy * u_f.y) * u_sp - dz * u_cp;
  float sx = u_view.x * 0.5 + u_focal * vx / vd;
  float sy = u_view.y * 0.5 - u_focal * vu / vd;
  float clipX = (sx / u_view.x) * 2.0 - 1.0;
  float clipY = 1.0 - (sy / u_view.y) * 2.0;
  gl_Position = vec4(clipX * vd, clipY * vd, 0.0, vd);
  v_uv = a_uv;
}
`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
}
`;

function compile(gl, type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(log || 'shader');
  }
  return shader;
}

export function createGroundRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: false,
    antialias: false,
    depth: false,
    premultipliedAlpha: false
  });
  if (!gl) return null;

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || 'link');
  }

  const buf = gl.createBuffer();
  const texOf = new Map();

  function texture(img) {
    let tex = texOf.get(img);
    if (tex) return tex;
    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    texOf.set(img, tex);
    return tex;
  }

  function forgetUnused(live) {
    if (texOf.size <= live.size + 24) return;
    for (const [img, tex] of texOf) {
      if (live.has(img)) continue;
      gl.deleteTexture(tex);
      texOf.delete(img);
    }
  }

  return {
    draw(camera, quads, clear) {
      const w = canvas.width;
      const h = canvas.height;
      if (!w || !h) return;
      gl.viewport(0, 0, w, h);
      gl.clearColor(clear[0], clear[1], clear[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!quads.length) return;

      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const loc = name => gl.getUniformLocation(program, name);
      gl.uniform1f(loc('u_eyeZ'), camera.eyeZ);
      gl.uniform2f(loc('u_f'), camera.fx, camera.fy);
      gl.uniform2f(loc('u_r'), camera.rx, camera.ry);
      gl.uniform1f(loc('u_sp'), camera.sp);
      gl.uniform1f(loc('u_cp'), camera.cp);
      gl.uniform1f(loc('u_focal'), camera.f);
      gl.uniform2f(loc('u_view'), camera.viewW, camera.viewH);

      const posLoc = gl.getAttribLocation(program, 'a_delta');
      const uvLoc = gl.getAttribLocation(program, 'a_uv');
      gl.enableVertexAttribArray(posLoc);
      gl.enableVertexAttribArray(uvLoc);

      const live = new Set();
      const data = new Float32Array(6 * 4);
      for (const q of quads) {
        let tex;
        try { tex = texture(q.img); } catch { continue; }
        live.add(q.img);
        const ex = camera.eyeX;
        const ey = camera.eyeY;
        const p = q.pts;
        const tris = [0, 1, 2, 0, 2, 3];
        let o = 0;
        for (const i of tris) {
          data[o++] = p[i].x - ex;
          data[o++] = p[i].y - ey;
          data[o++] = p[i].u;
          data[o++] = p[i].v;
        }
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
        gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      forgetUnused(live);
    }
  };
}

/** Split a tile until every corner is in front of the camera. */
export function groundQuads(camera, blits) {
  const out = [];
  const near = 2;
  function push(img, dest, u0, v0, u1, v1, level) {
    const pts = [
      { x: dest.x, y: dest.y, u: u0, v: v0 },
      { x: dest.x + dest.w, y: dest.y, u: u1, v: v0 },
      { x: dest.x + dest.w, y: dest.y + dest.h, u: u1, v: v1 },
      { x: dest.x, y: dest.y + dest.h, u: u0, v: v1 }
    ];
    const depths = pts.map(p => viewDepth(camera, p.x, p.y));
    if (depths.every(d => d > near)) {
      out.push({ img, pts, depth: Math.min(...depths) });
      return;
    }
    if (depths.every(d => d <= near) || level >= 3) return;
    const hw = dest.w / 2;
    const hh = dest.h / 2;
    const mu = (u0 + u1) / 2;
    const mv = (v0 + v1) / 2;
    const mx = dest.x + hw;
    const my = dest.y + hh;
    push(img, { x: dest.x, y: dest.y, w: hw, h: hh }, u0, v0, mu, mv, level + 1);
    push(img, { x: mx, y: dest.y, w: hw, h: hh }, mu, v0, u1, mv, level + 1);
    push(img, { x: dest.x, y: my, w: hw, h: hh }, u0, mv, mu, v1, level + 1);
    push(img, { x: mx, y: my, w: hw, h: hh }, mu, mv, u1, v1, level + 1);
  }
  for (const b of blits) push(b.img, b.dest, b.u0, b.v0, b.u1, b.v1, 0);
  out.sort((a, b) => b.depth - a.depth);
  return out;
}
