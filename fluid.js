/* ================================================================
   fluid.js — WebGL Navier-Stokes Fluid Simulation
   Sync or Sink website — interactive water background for hero
   
   Architecture:
     - GPU-side simulation via ping-pong FBOs
     - Passes: splat → divergence → pressure → grad-subtract → advect
     - Mouse/touch creates fluid splats
     - Auto-splats keep it alive when idle
     - Blends over hero's sky background with screen blend
   ================================================================ */

(function () {
  'use strict';

  // ── Configuration ───────────────────────────────────────────────
  var CFG = {
    SIM_RES: 128,    // velocity / pressure grid size
    DYE_RES: 512,    // colour dye grid size
    PRESS_ITER: 25,     // Jacobi pressure iterations
    SPLAT_RAD: 0.0004, // Gaussian radius (fraction of screen) — 90% smaller for subtle wakes
    FORCE: 5000,   // velocity magnitude from mouse drag
    VEL_DISS: 0.98,   // how fast velocity fades
    DYE_DISS: 0.970,  // how fast colour fades
    PRE_DISS: 0.80,   // pressure residual per frame
    AUTO_INT: 3.2,    // seconds between automatic splats
  };

  // Dark blue water colour palette for subtle underwater wakes
  var PAL = [
    [0.02, 0.08, 0.28],  // deep navy
    [0.04, 0.12, 0.35],  // dark blue
    [0.01, 0.06, 0.22],  // midnight blue
    [0.06, 0.15, 0.40],  // dark cerulean
    [0.03, 0.10, 0.30],  // deep water blue
    [0.05, 0.18, 0.45],  // dark ocean
  ];

  function rndCol() {
    var c = PAL[Math.floor(Math.random() * PAL.length)];
    var m = 0.6 + Math.random() * 0.4;
    return [c[0] * m, c[1] * m, c[2] * m];
  }

  // ── Canvas & GL context ─────────────────────────────────────────
  var canvas = document.getElementById('fluid-canvas');
  if (!canvas) return;

  var gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false })
    || canvas.getContext('experimental-webgl', { alpha: true, premultipliedAlpha: false });
  if (!gl) { console.warn('Fluid: WebGL not available'); return; }

  // Extension detection
  var extF = gl.getExtension('OES_texture_float');
  var extFl = extF && gl.getExtension('OES_texture_float_linear');
  var extH = !extF && gl.getExtension('OES_texture_half_float');
  var extHl = extH && gl.getExtension('OES_texture_half_float_linear');

  var TEX_TYPE = extF ? gl.FLOAT
    : extH ? extH.HALF_FLOAT_OES
      : gl.UNSIGNED_BYTE;
  var FILTER = (extF && extFl) || (extH && extHl) ? gl.LINEAR : gl.NEAREST;

  // ── Shader compiler ─────────────────────────────────────────────
  var VS = [
    'attribute vec2 aPos;',
    'varying vec2 vUv;',
    'void main(){',
    '  vUv = aPos * 0.5 + 0.5;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n');

  function compileFS(src) {
    return [
      'precision highp float;',
      'varying vec2 vUv;',
      src
    ].join('\n');
  }

  function mkProg(fsSrc) {
    var vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS); gl.compileShader(vs);
    var fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, compileFS(fsSrc)); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[fluid] FS compile error:', gl.getShaderInfoLog(fs));
      return null;
    }
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    // Collect uniforms
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p: p, u: u };
  }

  // ── Programs ────────────────────────────────────────────────────
  var PROG = {

    // Semi-Lagrangian advection
    advect: mkProg([
      'uniform sampler2D uVel, uSrc;',
      'uniform vec2 uTs;',          // velocity texel size
      'uniform float uDt, uDiss;',
      'void main() {',
      '  vec2 coord = vUv - uDt * texture2D(uVel, vUv).xy * uTs;',
      '  gl_FragColor = uDiss * texture2D(uSrc, coord);',
      '}'
    ].join('\n')),

    // Add Gaussian force/colour splat
    splat: mkProg([
      'uniform sampler2D uTgt;',
      'uniform vec2 uPt;',
      'uniform vec3 uCol;',
      'uniform float uRad, uAsp;',
      'void main() {',
      '  vec2 p = vUv - uPt; p.x *= uAsp;',
      '  float s = exp(-dot(p,p) / uRad);',
      '  gl_FragColor = vec4(texture2D(uTgt, vUv).rgb + s * uCol, 1.0);',
      '}'
    ].join('\n')),

    // Velocity divergence
    div: mkProg([
      'uniform sampler2D uVel;',
      'uniform vec2 uTs;',
      'void main() {',
      '  float l = texture2D(uVel, vUv - vec2(uTs.x, 0.0)).x;',
      '  float r = texture2D(uVel, vUv + vec2(uTs.x, 0.0)).x;',
      '  float t = texture2D(uVel, vUv + vec2(0.0, uTs.y)).y;',
      '  float b = texture2D(uVel, vUv - vec2(0.0, uTs.y)).y;',
      '  gl_FragColor = vec4(0.5*(r - l + t - b), 0.0, 0.0, 1.0);',
      '}'
    ].join('\n')),

    // Jacobi pressure iteration
    pressure: mkProg([
      'uniform sampler2D uPre, uDiv;',
      'uniform vec2 uTs;',
      'void main() {',
      '  float l = texture2D(uPre, vUv - vec2(uTs.x, 0.0)).x;',
      '  float r = texture2D(uPre, vUv + vec2(uTs.x, 0.0)).x;',
      '  float t = texture2D(uPre, vUv + vec2(0.0, uTs.y)).x;',
      '  float b = texture2D(uPre, vUv - vec2(0.0, uTs.y)).x;',
      '  float d = texture2D(uDiv, vUv).x;',
      '  gl_FragColor = vec4((l + r + t + b - d) * 0.25, 0.0, 0.0, 1.0);',
      '}'
    ].join('\n')),

    // Subtract pressure gradient from velocity
    gradSub: mkProg([
      'uniform sampler2D uPre, uVel;',
      'uniform vec2 uTs;',
      'void main() {',
      '  float l = texture2D(uPre, vUv - vec2(uTs.x, 0.0)).x;',
      '  float r = texture2D(uPre, vUv + vec2(uTs.x, 0.0)).x;',
      '  float t = texture2D(uPre, vUv + vec2(0.0, uTs.y)).x;',
      '  float b = texture2D(uPre, vUv - vec2(0.0, uTs.y)).x;',
      '  vec2 vel = texture2D(uVel, vUv).xy - vec2(r - l, t - b);',
      '  gl_FragColor = vec4(vel, 0.0, 1.0);',
      '}'
    ].join('\n')),

    // Multiply texture by scalar (clear pressure with dissipation)
    scale: mkProg([
      'uniform sampler2D uTex;',
      'uniform float uVal;',
      'void main() { gl_FragColor = uVal * texture2D(uTex, vUv); }'
    ].join('\n')),

    // Display dye as transparent layer
    display: mkProg([
      'uniform sampler2D uTex;',
      'void main() {',
      '  vec3 c = texture2D(uTex, vUv).rgb;',
      '  float a = max(c.r, max(c.g, c.b));',
      '  gl_FragColor = vec4(c, a * 0.45);',
      '}'
    ].join('\n')),
  };

  // ── Quad geometry (fullscreen -1..1) ────────────────────────────
  var vbuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  var ibuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,
    new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);

  function useProg(prog) {
    if (!prog) return null;
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
    var loc = gl.getAttribLocation(prog.p, 'aPos');
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    return prog.u;
  }

  function drawQuad(target) {
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ── FBO helpers ─────────────────────────────────────────────────
  function mkFBO(w, h) {
    gl.activeTexture(gl.TEXTURE0);
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, FILTER);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, FILTER);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, TEX_TYPE, null);

    var fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      tex: tex, fbo: fbo, w: w, h: h,
      sx: 1 / w, sy: 1 / h,
      bind: function (unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        return unit;
      }
    };
  }

  // Double-buffered FBO (ping-pong)
  function mkDFBO(w, h) {
    var a = mkFBO(w, h), b = mkFBO(w, h);
    return {
      w: w, h: h, sx: 1 / w, sy: 1 / h,
      get rd() { return a; },
      get wr() { return b; },
      swap: function () { var t = a; a = b; b = t; }
    };
  }

  function gridDims(res) {
    var ar = Math.max(canvas.width / canvas.height, 0.5);
    return { w: Math.round(res * Math.max(ar, 1)), h: Math.round(res * Math.max(1 / ar, 1)) };
  }

  // ── Allocate simulation buffers ─────────────────────────────────
  function initBuffers() {
    var sg = gridDims(CFG.SIM_RES);
    var dg = gridDims(CFG.DYE_RES);
    return {
      vel: mkDFBO(sg.w, sg.h),
      dye: mkDFBO(dg.w, dg.h),
      pre: mkDFBO(sg.w, sg.h),
      div: mkFBO(sg.w, sg.h),
    };
  }

  var BUF = initBuffers();

  // ── Simulation functions ─────────────────────────────────────────
  function splat(x, y, dx, dy, col) {
    var asp = canvas.width / canvas.height;

    // Velocity splat
    var u = useProg(PROG.splat);
    gl.uniform2f(u.uPt, x, y);
    gl.uniform1f(u.uRad, CFG.SPLAT_RAD);
    gl.uniform1f(u.uAsp, asp);
    gl.uniform1i(u.uTgt, BUF.vel.rd.bind(0));
    gl.uniform3f(u.uCol, dx, dy, 0.0);
    drawQuad(BUF.vel.wr); BUF.vel.swap();

    // Dye splat (larger radius)
    gl.uniform1i(u.uTgt, BUF.dye.rd.bind(0));
    gl.uniform3f(u.uCol, col[0], col[1], col[2]);
    gl.uniform1f(u.uRad, CFG.SPLAT_RAD * 5.0);
    drawQuad(BUF.dye.wr); BUF.dye.swap();
  }

  function step(dt) {
    gl.disable(gl.BLEND);

    // 1. Divergence of velocity
    var u = useProg(PROG.div);
    gl.uniform2f(u.uTs, BUF.vel.sx, BUF.vel.sy);
    gl.uniform1i(u.uVel, BUF.vel.rd.bind(0));
    drawQuad(BUF.div);

    // 2. Clear pressure (with dissipation)
    u = useProg(PROG.scale);
    gl.uniform1i(u.uTex, BUF.pre.rd.bind(0));
    gl.uniform1f(u.uVal, CFG.PRE_DISS);
    drawQuad(BUF.pre.wr); BUF.pre.swap();

    // 3. Pressure solve (Jacobi iterations)
    u = useProg(PROG.pressure);
    gl.uniform2f(u.uTs, BUF.vel.sx, BUF.vel.sy);
    gl.uniform1i(u.uDiv, BUF.div.bind(0));
    for (var i = 0; i < CFG.PRESS_ITER; i++) {
      gl.uniform1i(u.uPre, BUF.pre.rd.bind(1));
      drawQuad(BUF.pre.wr); BUF.pre.swap();
    }

    // 4. Gradient subtraction → divergence-free velocity
    u = useProg(PROG.gradSub);
    gl.uniform2f(u.uTs, BUF.vel.sx, BUF.vel.sy);
    gl.uniform1i(u.uPre, BUF.pre.rd.bind(0));
    gl.uniform1i(u.uVel, BUF.vel.rd.bind(1));
    drawQuad(BUF.vel.wr); BUF.vel.swap();

    // 5. Advect velocity
    u = useProg(PROG.advect);
    gl.uniform2f(u.uTs, BUF.vel.sx, BUF.vel.sy);
    gl.uniform1i(u.uVel, BUF.vel.rd.bind(0));
    gl.uniform1i(u.uSrc, BUF.vel.rd.bind(0));
    gl.uniform1f(u.uDt, dt);
    gl.uniform1f(u.uDiss, CFG.VEL_DISS);
    drawQuad(BUF.vel.wr); BUF.vel.swap();

    // 6. Advect dye (use velocity texel size for trace, render to dye target)
    gl.uniform2f(u.uTs, BUF.vel.sx, BUF.vel.sy);
    gl.uniform1i(u.uVel, BUF.vel.rd.bind(0));
    gl.uniform1i(u.uSrc, BUF.dye.rd.bind(1));
    gl.uniform1f(u.uDiss, CFG.DYE_DISS);
    drawQuad(BUF.dye.wr); BUF.dye.swap();
  }

  function render() {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    var u = useProg(PROG.display);
    gl.uniform1i(u.uTex, BUF.dye.rd.bind(0));
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ── Resize handling ─────────────────────────────────────────────
  var lastW = 0, lastH = 0;

  function resize() {
    var water = document.querySelector('.hero-water');
    var w = water ? water.offsetWidth : (canvas.parentElement.offsetWidth || window.innerWidth);
    var h = water ? water.offsetHeight : (canvas.parentElement.offsetHeight || window.innerHeight);
    if (w === lastW && h === lastH) return;
    canvas.width = w; canvas.height = h;
    lastW = w; lastH = h;
    // Re-create buffers at new resolution
    BUF = initBuffers();
    // Seed fresh splats after resize
    for (var i = 0; i < 5; i++) autoSplat();
  }

  // ── Input handling ──────────────────────────────────────────────
  var mx = 0.5, my = 0.5, pmx = 0.5, pmy = 0.5;

  function getHeroCoords(clientX, clientY) {
    var water = document.querySelector('.hero-water');
    var r = water ? water.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return {
      x: (clientX - r.left) / r.width,
      y: 1.0 - (clientY - r.top) / r.height
    };
  }

  function onMove(clientX, clientY) {
    pmx = mx; pmy = my;
    var pos = getHeroCoords(clientX, clientY);
    mx = pos.x; my = pos.y;
    var dx = (mx - pmx) * CFG.FORCE;
    var dy = (my - pmy) * CFG.FORCE;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) {
      splat(mx, my, dx, dy, rndCol());
    }
  }

  function onClick(clientX, clientY) {
    var pos = getHeroCoords(clientX, clientY);
    var col = rndCol();
    for (var i = 0; i < 6; i++) {
      splat(pos.x, pos.y,
        (Math.random() - 0.5) * CFG.FORCE * 2,
        (Math.random() - 0.5) * CFG.FORCE * 2,
        col);
    }
  }

  var waterZone = document.querySelector('.hero-water');
  if (waterZone) {
    waterZone.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
    waterZone.addEventListener('click', function (e) { onClick(e.clientX, e.clientY); });
    waterZone.addEventListener('touchmove', function (e) {
      e.preventDefault();
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    waterZone.addEventListener('touchstart', function (e) {
      onClick(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
  }

  // ── Auto-splat (keeps animation alive when idle) ─────────────────
  function autoSplat() {
    var x = 0.1 + Math.random() * 0.8;
    var y = 0.1 + Math.random() * 0.8;
    var angle = Math.random() * Math.PI * 2;
    var mag = (0.4 + Math.random() * 0.6) * CFG.FORCE;
    splat(x, y,
      Math.cos(angle) * mag,
      Math.sin(angle) * mag,
      rndCol());
  }

  // ── Main loop ────────────────────────────────────────────────────
  var lastTime = performance.now();
  var autoTimer = 0.0;

  // Initial seed
  resize();
  for (var s = 0; s < 10; s++) autoSplat();

  function loop(now) {
    var dt = Math.min((now - lastTime) / 1000.0, 0.016);
    lastTime = now;
    autoTimer += dt;

    resize();

    if (autoTimer >= CFG.AUTO_INT) {
      autoSplat();
      autoTimer = 0.0;
    }

    step(dt);
    render();
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);

})();
