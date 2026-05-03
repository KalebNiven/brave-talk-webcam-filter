/**
 * AI Webcam Effects — Main World Injected Script (injected.js)
 *
 * Runs in the PAGE's main JS world — can override navigator.mediaDevices.getUserMedia.
 * No chrome.* APIs available here. Communicates with the isolated bridge via CustomEvents:
 *   ISOLATED → MAIN : window event 'awe:state'   (detail = state object)
 *   MAIN → ISOLATED : window event 'awe:ready'
 *
 * Bugs fixed vs original design:
 *  1. Now runs in MAIN world — getUserMedia intercept actually works
 *  2. preserveDrawingBuffer:true on WebGL context — multi-pass readback works
 *  3. Separate readbackCanvas for ping-pong instead of glCanvas.getContext('2d')
 */

import { ImageSegmenter, FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

// ── State ──
let state = {
  pluginEnabled: true,
  enhancer:   { enabled: false, level: 60 },
  background: { mode: 'none', color: '#1a1a2e', imageUrl: '' },
  watermark:  { enabled: false, text: 'My Watermark' },
  blur:       { enabled: false, level: 50 },
  beauty:     { enabled: false, level: 50 },
};

// ── Globals ──
let segmenter = null;
let segmenterReady = false;
let segmenterLoading = false;
let faceLandmarker = null;
let faceLandmarkerReady = false;
let faceLandmarkerLoading = false;
let originalStream = null;
let rafId = null;

const video  = document.createElement('video');
video.muted  = true;
video.playsInline = true;

// Output canvas — what the page gets as its MediaStream
const outCanvas = document.createElement('canvas');
const outCtx    = outCanvas.getContext('2d');

// WebGL canvas — Bug fix: preserveDrawingBuffer so we can read it back via drawImage
const glCanvas = document.createElement('canvas');
const gl = glCanvas.getContext('webgl2', { preserveDrawingBuffer: true })
        || glCanvas.getContext('webgl',  { preserveDrawingBuffer: true });

// Bug fix: separate 2D canvas for ping-pong readback between GL passes
const readbackCanvas = document.createElement('canvas');
const readbackCtx    = readbackCanvas.getContext('2d');

const cheekMaskCanvas = document.createElement('canvas');
const cheekMaskCtx    = cheekMaskCanvas.getContext('2d');

// Background compositing canvas
const bgCanvas = document.createElement('canvas');
const bgCtx    = bgCanvas.getContext('2d');

// Background image cache
let bgImageEl  = null;
let lastBgUrl  = '';

// ── GLSL Shaders ──

const VERT_SRC = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // Flip Y so canvas draws right-side up
    v_texCoord = vec2(a_texCoord.x, 1.0 - a_texCoord.y);
  }
`;

const ENHANCER_FRAG = `
  precision mediump float;
  uniform sampler2D u_texture;
  uniform vec2 u_resolution;
  uniform float u_sharpness;
  uniform float u_brightness;
  uniform float u_contrast;
  uniform float u_vibrance;
  varying vec2 v_texCoord;

  vec3 unsharpMask(sampler2D tex, vec2 uv, vec2 res, float strength) {
    vec2 px = 1.0 / res;
    vec3 center = texture2D(tex, uv).rgb;
    vec3 blurred =
      texture2D(tex, uv + vec2(-px.x,  0.0 )).rgb * 0.25 +
      texture2D(tex, uv + vec2( px.x,  0.0 )).rgb * 0.25 +
      texture2D(tex, uv + vec2( 0.0,  -px.y)).rgb * 0.25 +
      texture2D(tex, uv + vec2( 0.0,   px.y)).rgb * 0.25;
    return center + (center - blurred) * strength;
  }

  vec3 adjustVibrance(vec3 c, float v) {
    float avg = (c.r + c.g + c.b) / 3.0;
    float mx  = max(c.r, max(c.g, c.b));
    float sat = (mx - avg) / (mx + 0.001);
    return mix(vec3(avg), c, 1.0 + (1.0 - sat) * v);
  }

  void main() {
    vec3 color = unsharpMask(u_texture, v_texCoord, u_resolution, u_sharpness * 3.0);
    color = clamp(color + u_brightness * 0.15, 0.0, 1.0);
    color = clamp((color - 0.5) * (1.0 + u_contrast * 0.3) + 0.5, 0.0, 1.0);
    color = adjustVibrance(color, u_vibrance * 0.6);
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

const BEAUTY_FRAG = `
  precision mediump float;
  uniform sampler2D u_texture;
  uniform sampler2D u_cheekMask;
  uniform vec2 u_resolution;
  uniform float u_strength;
  uniform float u_debugMode;
  varying vec2 v_texCoord;

  float luma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
  }

  // Skin detection using YCbCr color space
  float skinMask(vec3 c) {
    float y  = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    float cb = 0.5 + (-0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b);
    float cr = 0.5 + ( 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b);
    float cbMask = smoothstep(0.35, 0.40, cb) * (1.0 - smoothstep(0.55, 0.62, cb));
    float crMask = smoothstep(0.45, 0.50, cr) * (1.0 - smoothstep(0.70, 0.78, cr));
    float bright = smoothstep(0.10, 0.25, y);
    float spread = max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b);
    float saturation = smoothstep(0.05, 0.12, spread);
    float warmth = smoothstep(0.02, 0.08, c.r - c.b);
    float baseSkin = cbMask * crMask * bright * saturation * warmth;
    float neutralCb = smoothstep(0.46, 0.485, cb) * (1.0 - smoothstep(0.515, 0.57, cb));
    float neutralCr = smoothstep(0.46, 0.485, cr) * (1.0 - smoothstep(0.515, 0.57, cr));
    float neutralFallback = neutralCb * neutralCr * smoothstep(0.13, 0.38, y) * (1.0 - smoothstep(0.61, 0.84, y)) * (1.0 - smoothstep(0.055, 0.18, spread));
    return clamp(max(baseSkin, neutralFallback * 0.36), 0.0, 1.0);
  }

  // Bilateral filter - edge-preserving smoothing
  // Spatial weight * Color similarity weight
  vec3 bilateralFilter(sampler2D tex, vec2 uv, vec2 px, float sigmaSpace, float sigmaColor, float skinMaskValue) {
    vec3 center = texture2D(tex, uv).rgb;
    vec3 sum = vec3(0.0);
    float weightSum = 0.0;
    
    float centerLuma = luma(center);
    int kernelRadius = 2;
    
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        vec2 offset = vec2(float(x), float(y)) * px;
        vec3 sampleColor = texture2D(tex, uv + offset).rgb;
        
        // Spatial Gaussian weight (distance from center)
        float spatialDist = length(vec2(float(x), float(y)));
        float spatialWeight = exp(-(spatialDist * spatialDist) / (2.0 * sigmaSpace * sigmaSpace));
        
        // Color Gaussian weight (difference in luminance)
        float sampleLuma = luma(sampleColor);
        float colorDist = abs(sampleLuma - centerLuma);
        float colorWeight = exp(-(colorDist * colorDist) / (2.0 * sigmaColor * sigmaColor));
        
        // Combined bilateral weight
        float weight = spatialWeight * colorWeight * skinMaskValue;
        
        sum += sampleColor * weight;
        weightSum += weight;
      }
    }
    
    return weightSum > 0.0 ? sum / weightSum : center;
  }

  // Calculate local texture roughness (variance from smooth average)
  // Only measures roughness WITHIN skin areas, excludes edges
  float textureRoughness(sampler2D tex, vec2 uv, vec2 px, float skinMaskValue) {
    // Skip roughness calculation if not on skin
    if (skinMaskValue < 0.2) return 0.0;
    
    vec3 center = texture2D(tex, uv).rgb;
    
    // Small blur for local average (only consider skin pixels)
    vec3 avg = vec3(0.0);
    float skinSum = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        vec2 offset = vec2(float(x), float(y)) * px;
        vec3 sampleColor = texture2D(tex, uv + offset).rgb;
        float sampleSkin = skinMask(sampleColor);
        avg += sampleColor * sampleSkin;
        skinSum += sampleSkin;
      }
    }
    // Only proceed if we have enough skin neighbors
    if (skinSum < 5.0) return 0.0;
    avg /= skinSum;
    float avgLuma = luma(avg);
    
    // Measure local variance (roughness) - only from skin pixels
    float variance = 0.0;
    float skinWeightSum = 0.0;
    for (int x = -1; x <= 1; x++) {
      for (int y = -1; y <= 1; y++) {
        vec2 offset = vec2(float(x), float(y)) * px;
        vec3 sampleColor = texture2D(tex, uv + offset).rgb;
        float sampleSkin = skinMask(sampleColor);
        if (sampleSkin > 0.1) {
          float diff = luma(sampleColor) - avgLuma;
          variance += diff * diff * sampleSkin;
          skinWeightSum += sampleSkin;
        }
      }
    }
    if (skinWeightSum < 1.0) return 0.0;
    variance /= skinWeightSum;
    
    // Normalize and threshold - higher variance = rougher texture (acne)
    // Lower threshold since we're now only measuring on skin
    return smoothstep(0.0005, 0.004, variance);
  }

  void main() {
    vec2 px = 1.0 / u_resolution;
    vec3 original = texture2D(u_texture, v_texCoord).rgb;
    float cheek = texture2D(u_cheekMask, v_texCoord).r;
    
    // Compute skin mask with local average for stability
    float pixelSkin = skinMask(original);
    vec3 localAvg = vec3(0.0);
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        localAvg += texture2D(u_texture, v_texCoord + vec2(float(x), float(y)) * px).rgb;
      }
    }
    localAvg /= 25.0;
    float avgSkin = skinMask(localAvg);
    float avgSpread = max(max(localAvg.r, localAvg.g), localAvg.b) - min(min(localAvg.r, localAvg.g), localAvg.b);
    float pixelSpread = max(max(original.r, original.g), original.b) - min(min(original.r, original.g), original.b);
    float neutralSkin = smoothstep(0.14, 0.36, luma(localAvg)) * (1.0 - smoothstep(0.62, 0.84, luma(localAvg))) * (1.0 - smoothstep(0.05, 0.17, pixelSpread + avgSpread * 0.6)) * (1.0 - smoothstep(0.04, 0.14, abs(luma(original) - luma(localAvg))));
    float skin = clamp(max(smoothstep(0.2, 0.5, (pixelSkin + avgSkin) * 0.5), neutralSkin * 0.58), 0.0, 1.0);
    
    // Sigma parameters based on strength slider (0-1)
    float sigmaSpace = 2.0 + u_strength * 3.0;  // 2-5 pixel radius effect
    float sigmaColor = 0.08 - u_strength * 0.04; // 0.08-0.04 color tolerance
    
    // Apply bilateral filter only on skin areas
    vec3 bilateral = bilateralFilter(u_texture, v_texCoord, px, sigmaSpace, sigmaColor, skin);
    float cheekBoost = smoothstep(0.12, 0.72, cheek);
    vec3 strongBilateral = bilateralFilter(
      u_texture,
      v_texCoord,
      px,
      sigmaSpace * (1.15 + cheekBoost * 0.85),
      sigmaColor * (1.25 + cheekBoost * 0.18),
      skin
    );
    vec3 glamBilateral = bilateralFilter(
      u_texture,
      v_texCoord,
      px,
      sigmaSpace * (1.45 + cheekBoost * 0.95),
      sigmaColor * (1.45 + cheekBoost * 0.22),
      skin
    );
    
    // Frequency separation: separate base color (low freq) from texture (high freq)
    vec3 baseColor = mix(bilateral, strongBilateral, 0.45 + cheekBoost * 0.15);
    vec3 highFreq = original - bilateral;
    
    // Detect red blemishes only in cheek areas
    float redBias = max((original.r - ((original.g + original.b) * 0.5)) - (baseColor.r - ((baseColor.g + baseColor.b) * 0.5)) * 0.92, 0.0);
    float redness = smoothstep(0.004, 0.05, redBias);
    float roughness = textureRoughness(u_texture, v_texCoord, px, skin);
    float textureDelta = (abs(original.r - bilateral.r) + abs(original.g - bilateral.g) + abs(original.b - bilateral.b)) / 3.0;
    float localContrast = smoothstep(0.012, 0.055, textureDelta + abs(luma(original) - luma(baseColor)) * 0.65);
    float edge = abs(luma(texture2D(u_texture, v_texCoord + vec2(px.x, 0.0)).rgb) - luma(texture2D(u_texture, v_texCoord - vec2(px.x, 0.0)).rgb)) + abs(luma(texture2D(u_texture, v_texCoord + vec2(0.0, px.y)).rgb) - luma(texture2D(u_texture, v_texCoord - vec2(0.0, px.y)).rgb));
    float edgeReject = 1.0 - smoothstep(0.035, 0.12, edge);
    float acneSeed = max(redness * (0.86 + cheekBoost * 0.12), max(roughness * 0.76, localContrast * 0.68));
    float acneFocus = clamp(acneSeed * skin * edgeReject * (0.74 + cheekBoost * 0.16), 0.0, 1.0);
    
    float baseSmoothAmount = skin * edgeReject * (0.045 + u_strength * 0.06) * (0.34 + cheekBoost * 0.66);
    float spotAmount = acneFocus * (0.24 + u_strength * 0.28);
    vec3 acneBase = mix(strongBilateral, glamBilateral, min(1.0, 0.32 + acneFocus * 0.28));
    vec3 smoothedBase = mix(mix(original, baseColor, baseSmoothAmount), acneBase, spotAmount);
    
    float detailMask = smoothstep(0.015, 0.09, textureDelta) * (0.42 + edgeReject * 0.58);
    float detailPreserve = clamp((0.14 + detailMask) * (1.0 - acneFocus * (0.34 + u_strength * 0.12)), 0.0, 1.0);
    vec3 preservedDetail = highFreq * detailPreserve * 0.92;
    
    vec3 result = smoothedBase + preservedDetail;
    
    float toneCorrectAmount = acneFocus * (0.14 + u_strength * 0.12);
    vec3 toneCorrected = vec3(
      mix(result.r, min(result.r, baseColor.r * 1.01), toneCorrectAmount),
      mix(result.g, mix(result.g, baseColor.g, 0.16), toneCorrectAmount * 0.55),
      mix(result.b, mix(result.b, baseColor.b, 0.1), toneCorrectAmount * 0.55)
    );
    result = mix(result, toneCorrected, toneCorrectAmount);
    
    float finishAmount = skin * edgeReject * (0.01 + u_strength * 0.022) * (0.34 + acneFocus * 0.42);
    vec3 finishBase = mix(bilateral, strongBilateral, 0.28 + cheekBoost * 0.18);
    result = mix(result, finishBase, finishAmount);
    
    // Debug mode: show roughness (red) and skin mask (green)
    // Red = rough/acne areas getting stronger smoothing
    // Green = skin areas
    if (u_debugMode > 0.5) {
      vec3 debug = vec3(acneFocus, skin * edgeReject, detailPreserve);
      gl_FragColor = vec4(mix(original * 0.3, debug, 0.85), 1.0);
      return;
    }
    
    // Split view debug
    if (u_debugMode > 1.5) {
      float divider = smoothstep(0.498, 0.5, v_texCoord.x) - smoothstep(0.5, 0.502, v_texCoord.x);
      vec3 splitView = v_texCoord.x < 0.5 ? original : result;
      gl_FragColor = vec4(mix(splitView, vec3(0.0, 1.0, 1.0), divider), 1.0);
      return;
    }

    gl_FragColor = vec4(result, 1.0);
  }
`;

const PASSTHROUGH_FRAG = `
  precision mediump float;
  uniform sampler2D u_texture;
  varying vec2 v_texCoord;
  void main() {
    gl_FragColor = texture2D(u_texture, v_texCoord);
  }
`;

// ── WebGL init ──
let progEnhancer, progBeauty, progPassthrough;
let quadBuffer, texInput, texCheekMask;
let glInitialized = false;

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[AIWebcam] Shader compile error:', gl.getShaderInfoLog(s));
  }
  return s;
}

function createProgram(vSrc, fSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compileShader(gl.VERTEX_SHADER, vSrc));
  gl.attachShader(p, compileShader(gl.FRAGMENT_SHADER, fSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[AIWebcam] Program link error:', gl.getProgramInfoLog(p));
  }
  return p;
}

function initGL(w, h) {
  if (!gl) return;
  glCanvas.width       = w;
  glCanvas.height      = h;
  readbackCanvas.width = w;
  readbackCanvas.height = h;
  gl.viewport(0, 0, w, h);

  progEnhancer    = createProgram(VERT_SRC, ENHANCER_FRAG);
  progBeauty      = createProgram(VERT_SRC, BEAUTY_FRAG);
  progPassthrough = createProgram(VERT_SRC, PASSTHROUGH_FRAG);

  // CCW quad covering clip-space [-1,1]x[-1,1], UV [0,1]x[0,1]
  const verts = new Float32Array([
    -1, -1,  0, 0,
     1, -1,  1, 0,
    -1,  1,  0, 1,
     1,  1,  1, 1,
  ]);
  quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

  texInput = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texInput);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  texCheekMask = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texCheekMask);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  glInitialized = true;
}

function bindQuad(prog) {
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  const posLoc = gl.getAttribLocation(prog, 'a_position');
  const texLoc = gl.getAttribLocation(prog, 'a_texCoord');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(texLoc);
  gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 16, 8);
}

function uploadTexture(source) {
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texInput);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

function uploadCheekMask(source) {
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texCheekMask);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

// After a GL draw, copy glCanvas → readbackCanvas so next pass can re-upload
function readbackToIntermediate() {
  readbackCtx.drawImage(glCanvas, 0, 0);
}

function runEnhancerPass(w, h) {
  bindQuad(progEnhancer);
  const n = state.enhancer.level / 100;
  gl.uniform1i(gl.getUniformLocation(progEnhancer, 'u_texture'), 0);
  gl.uniform2f(gl.getUniformLocation(progEnhancer, 'u_resolution'), w, h);
  gl.uniform1f(gl.getUniformLocation(progEnhancer, 'u_sharpness'),  n);
  gl.uniform1f(gl.getUniformLocation(progEnhancer, 'u_brightness'), n);
  gl.uniform1f(gl.getUniformLocation(progEnhancer, 'u_contrast'),   n);
  gl.uniform1f(gl.getUniformLocation(progEnhancer, 'u_vibrance'),   n);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function runBeautyPass(w, h) {
  bindQuad(progBeauty);
  gl.uniform1i(gl.getUniformLocation(progBeauty, 'u_texture'), 0);
  gl.uniform1i(gl.getUniformLocation(progBeauty, 'u_cheekMask'), 1);
  gl.uniform2f(gl.getUniformLocation(progBeauty, 'u_resolution'), w, h);
  gl.uniform1f(gl.getUniformLocation(progBeauty, 'u_strength'), state.beauty.level / 100);
  gl.uniform1f(gl.getUniformLocation(progBeauty, 'u_debugMode'), window.__AIWebcamBeautyDebugMode || 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function runPassthrough() {
  bindQuad(progPassthrough);
  gl.uniform1i(gl.getUniformLocation(progPassthrough, 'u_texture'), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ── MediaPipe segmenter ──
async function initSegmenter() {
  if (segmenterReady || segmenterLoading) return;
  segmenterLoading = true;
  try {
    const wasmBase = window.__aweWasmBase;
    if (!wasmBase) {
      console.warn('[AIWebcam] wasmBase not found — segmentation disabled');
      return;
    }
    const vision = await FilesetResolver.forVisionTasks(wasmBase);
    segmenter = await ImageSegmenter.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
        delegate: 'GPU',
      },
      outputCategoryMask: true,
      outputConfidenceMasks: false,
      runningMode: 'VIDEO',
    });
    segmenterReady = true;
    console.log('[AIWebcam] Segmenter ready');
  } catch (e) {
    console.warn('[AIWebcam] Segmenter init failed:', e);
  }
}

async function initFaceLandmarker() {
  if (faceLandmarkerReady || faceLandmarkerLoading) return;
  faceLandmarkerLoading = true;
  try {
    const wasmBase = window.__aweWasmBase;
    if (!wasmBase) {
      console.warn('[AIWebcam] wasmBase not found — face landmarks disabled');
      return;
    }
    const vision = await FilesetResolver.forVisionTasks(wasmBase);
    faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    faceLandmarkerReady = true;
    console.log('[AIWebcam] Face landmarker ready');
  } catch (e) {
    console.warn('[AIWebcam] Face landmarker init failed:', e);
  }
}

function averagePoint(points) {
  const sum = points.reduce((acc, point) => {
    acc.x += point.x;
    acc.y += point.y;
    return acc;
  }, { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

function pickPoint(landmarks, index, fallback) {
  const point = landmarks[index];
  return point ? { x: point.x, y: point.y } : fallback;
}

function pointDistance(a, b, w, h) {
  const dx = (a.x - b.x) * w;
  const dy = (a.y - b.y) * h;
  return Math.sqrt(dx * dx + dy * dy);
}

function drawSoftEllipse(ctx, cx, cy, rx, ry, alpha) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(Math.max(rx, 1), Math.max(ry, 1));
  const gradient = ctx.createRadialGradient(0, 0, 0.12, 0, 0, 1.0);
  gradient.addColorStop(0.0, `rgba(255,255,255,${alpha})`);
  gradient.addColorStop(0.68, `rgba(255,255,255,${alpha * 0.82})`);
  gradient.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function cutEllipse(ctx, cx, cy, rx, ry) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.translate(cx, cy);
  ctx.scale(Math.max(rx, 1), Math.max(ry, 1));
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.beginPath();
  ctx.arc(0, 0, 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function updateCheekMask(w, h, landmarks) {
  cheekMaskCanvas.width = w;
  cheekMaskCanvas.height = h;
  cheekMaskCtx.clearRect(0, 0, w, h);

  if (!landmarks || !landmarks.length) return;

  const forehead = pickPoint(landmarks, 10, { x: 0.5, y: 0.2 });
  const chin = pickPoint(landmarks, 152, { x: 0.5, y: 0.8 });
  const nose = pickPoint(landmarks, 4, { x: 0.5, y: 0.5 });
  const jawLeft = pickPoint(landmarks, 234, { x: 0.22, y: 0.55 });
  const jawRight = pickPoint(landmarks, 454, { x: 0.78, y: 0.55 });
  const leftEye = averagePoint([
    pickPoint(landmarks, 33, { x: 0.36, y: 0.4 }),
    pickPoint(landmarks, 133, { x: 0.42, y: 0.4 }),
    pickPoint(landmarks, 159, { x: 0.39, y: 0.38 }),
    pickPoint(landmarks, 145, { x: 0.39, y: 0.42 }),
  ]);
  const rightEye = averagePoint([
    pickPoint(landmarks, 263, { x: 0.64, y: 0.4 }),
    pickPoint(landmarks, 362, { x: 0.58, y: 0.4 }),
    pickPoint(landmarks, 386, { x: 0.61, y: 0.38 }),
    pickPoint(landmarks, 374, { x: 0.61, y: 0.42 }),
  ]);
  const mouthLeft = pickPoint(landmarks, 61, { x: 0.42, y: 0.66 });
  const mouthRight = pickPoint(landmarks, 291, { x: 0.58, y: 0.66 });
  const mouthCenter = averagePoint([mouthLeft, mouthRight]);
  const faceWidth = pointDistance(jawLeft, jawRight, w, h);
  const faceHeight = pointDistance(forehead, chin, w, h);
  const eyeLineY = ((leftEye.y + rightEye.y) * 0.5) * h;
  const mouthLineY = mouthCenter.y * h;
  const cheekCenterY = eyeLineY * 0.4 + mouthLineY * 0.6 + faceHeight * 0.02;
  const leftCenterX = (jawLeft.x * 0.52 + nose.x * 0.48) * w;
  const rightCenterX = (jawRight.x * 0.52 + nose.x * 0.48) * w;
  const sideWidthLeft = Math.abs(nose.x - jawLeft.x) * w;
  const sideWidthRight = Math.abs(jawRight.x - nose.x) * w;
  const cheekRadiusY = Math.max((mouthLineY - eyeLineY) * 0.58, faceHeight * 0.14);
  const leftRadiusX = Math.max(sideWidthLeft * 0.72, faceWidth * 0.14);
  const rightRadiusX = Math.max(sideWidthRight * 0.72, faceWidth * 0.14);
  const eyeRadiusX = Math.max(pointDistance(pickPoint(landmarks, 33, leftEye), pickPoint(landmarks, 133, leftEye), w, h) * 1.05, faceWidth * 0.045);
  const eyeRadiusY = Math.max(faceHeight * 0.04, eyeRadiusX * 0.58);
  const mouthRadiusX = Math.max(pointDistance(mouthLeft, mouthRight, w, h) * 0.95, faceWidth * 0.11);
  const mouthRadiusY = Math.max(faceHeight * 0.07, mouthRadiusX * 0.42);
  const noseRadiusX = Math.max(faceWidth * 0.065, 14);
  const noseRadiusY = Math.max(faceHeight * 0.12, 20);

  drawSoftEllipse(cheekMaskCtx, leftCenterX, cheekCenterY, leftRadiusX, cheekRadiusY, 1.0);
  drawSoftEllipse(cheekMaskCtx, rightCenterX, cheekCenterY, rightRadiusX, cheekRadiusY, 1.0);
  cutEllipse(cheekMaskCtx, leftEye.x * w, leftEye.y * h, eyeRadiusX, eyeRadiusY);
  cutEllipse(cheekMaskCtx, rightEye.x * w, rightEye.y * h, eyeRadiusX, eyeRadiusY);
  cutEllipse(cheekMaskCtx, mouthCenter.x * w, mouthCenter.y * h, mouthRadiusX, mouthRadiusY);
  cutEllipse(cheekMaskCtx, nose.x * w, cheekCenterY, noseRadiusX, noseRadiusY);
}

// ── Background compositing ──
function applyBackground(w, h, glSource, maskData) {
  bgCanvas.width  = w;
  bgCanvas.height = h;
  bgCtx.clearRect(0, 0, w, h);

  const mode = state.background.mode;

  if (mode === 'blur') {
    const px = Math.round(8 + (state.blur.level / 100) * 16);
    bgCtx.filter = `blur(${px}px)`;
    bgCtx.drawImage(glSource, 0, 0);
    bgCtx.filter = 'none';
  } else if (mode === 'color') {
    bgCtx.fillStyle = state.background.color;
    bgCtx.fillRect(0, 0, w, h);
  } else if (mode === 'image') {
    const url = state.background.imageUrl;
    if (url && url !== lastBgUrl) {
      lastBgUrl = url;
      bgImageEl = new Image();
      bgImageEl.crossOrigin = 'anonymous';
      bgImageEl.src = url;
    }
    if (bgImageEl && bgImageEl.complete && bgImageEl.naturalWidth > 0) {
      bgCtx.drawImage(bgImageEl, 0, 0, w, h);
    } else {
      bgCtx.fillStyle = '#111';
      bgCtx.fillRect(0, 0, w, h);
    }
  }

  // Composite person on top of background using mask
  if (maskData) {
    const personCanvas   = document.createElement('canvas');
    personCanvas.width   = w;
    personCanvas.height  = h;
    const pCtx           = personCanvas.getContext('2d');
    pCtx.drawImage(glSource, 0, 0);
    const imgData = pCtx.getImageData(0, 0, w, h);
    const px      = imgData.data;
    for (let i = 0; i < maskData.length; i++) {
      px[i * 4 + 3] = maskData[i] > 0.5 ? 255 : 0;
    }
    pCtx.putImageData(imgData, 0, 0);
    bgCtx.drawImage(personCanvas, 0, 0);
  } else {
    bgCtx.drawImage(glSource, 0, 0);
  }
}

function applyFullBlur(w, h, glSource) {
  bgCanvas.width  = w;
  bgCanvas.height = h;
  const px = Math.round(4 + (state.blur.level / 100) * 12);
  bgCtx.filter = `blur(${px}px)`;
  bgCtx.drawImage(glSource, 0, 0);
  bgCtx.filter = 'none';
}

function drawWatermark(targetCtx, w, h) {
  if (!state.watermark.enabled || !state.watermark.text) return;
  const fs = Math.max(12, Math.round(w * 0.035));
  targetCtx.save();
  targetCtx.font        = `bold ${fs}px sans-serif`;
  targetCtx.fillStyle   = 'rgba(255,255,255,0.7)';
  targetCtx.shadowColor = 'rgba(0,0,0,0.6)';
  targetCtx.shadowBlur  = 4;
  targetCtx.fillText(state.watermark.text, 14, h - 14);
  targetCtx.restore();
}

// ── Main render loop ──
let lastSegmentTime = 0;
let lastMask = null;
let lastFaceTime = 0;
let lastFaceLandmarks = null;

function renderFrame() {
  if (!state.pluginEnabled || !originalStream || video.readyState < 2) {
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) {
    rafId = requestAnimationFrame(renderFrame);
    return;
  }

  // Resize if needed
  if (outCanvas.width !== w || outCanvas.height !== h) {
    outCanvas.width  = w;
    outCanvas.height = h;
  }
  if (glCanvas.width !== w || glCanvas.height !== h || !glInitialized) {
    initGL(w, h);
  }
  if (cheekMaskCanvas.width !== w || cheekMaskCanvas.height !== h) {
    updateCheekMask(w, h, lastFaceLandmarks);
  }

  // 1. Draw raw video frame to readback canvas (source for GL)
  if (readbackCanvas.width !== w || readbackCanvas.height !== h) {
    readbackCanvas.width = w;
    readbackCanvas.height = h;
  }
  readbackCtx.drawImage(video, 0, 0, w, h);

  // 2. Segmentation (~15fps)
  const needSeg = state.pluginEnabled &&
    (state.background.mode !== 'none' || state.blur.enabled);

  if (needSeg && segmenterReady && segmenter) {
    const now = performance.now();
    if (now - lastSegmentTime > 66) {
      lastSegmentTime = now;
      try {
        const result = segmenter.segmentForVideo(video, now);
        if (result && result.categoryMask) {
          lastMask = result.categoryMask.getAsFloat32Array();
          result.categoryMask.close();
        }
      } catch (_) {}
    }
  } else if (!needSeg) {
    lastMask = null;
  }

  if (state.pluginEnabled && state.beauty.enabled && faceLandmarkerReady && faceLandmarker) {
    const now = performance.now();
    if (now - lastFaceTime > 83) {
      lastFaceTime = now;
      try {
        const result = faceLandmarker.detectForVideo(video, now);
        lastFaceLandmarks = result && result.faceLandmarks && result.faceLandmarks.length
          ? result.faceLandmarks[0]
          : null;
        updateCheekMask(w, h, lastFaceLandmarks);
      } catch (_) {}
    }
  } else if (!state.beauty.enabled && lastFaceLandmarks) {
    lastFaceLandmarks = null;
    updateCheekMask(w, h, null);
  }

  // 3. WebGL effects
  if (gl && glInitialized) {
    gl.viewport(0, 0, w, h);
    uploadTexture(readbackCtx.canvas); // upload from 2D canvas
    const beautyDebugActive = state.beauty.enabled && (window.__AIWebcamBeautyDebugMode || 0) > 0;

    if (state.beauty.enabled) {
      uploadCheekMask(cheekMaskCanvas);
      runBeautyPass(w, h);
      readbackToIntermediate();
      uploadTexture(readbackCanvas);
    }

    if (state.enhancer.enabled && !beautyDebugActive) {
      runEnhancerPass(w, h);
      readbackToIntermediate();
      uploadTexture(readbackCanvas);
    }

    if (!state.enhancer.enabled && !state.beauty.enabled) {
      runPassthrough();
    }
  } else {
    // No WebGL: just copy video frame to glCanvas via 2D fallback canvas
    readbackCtx.drawImage(video, 0, 0, w, h);
  }

  // glCanvas now holds the processed frame (or readbackCanvas if no GL passes ran)
  const glSource = (gl && glInitialized) ? glCanvas : readbackCanvas;

  // 4. Background / blur compositing
  const bgMode  = state.background.mode;
  const useBlur = state.blur.enabled && bgMode === 'none';

  if (bgMode !== 'none') {
    applyBackground(w, h, glSource, lastMask);
    outCtx.clearRect(0, 0, w, h);
    outCtx.drawImage(bgCanvas, 0, 0);
  } else if (useBlur) {
    applyFullBlur(w, h, glSource);
    outCtx.clearRect(0, 0, w, h);
    outCtx.drawImage(bgCanvas, 0, 0);
  } else {
    outCtx.clearRect(0, 0, w, h);
    outCtx.drawImage(glSource, 0, 0);
  }

  // 5. Watermark overlay
  drawWatermark(outCtx, w, h);

  rafId = requestAnimationFrame(renderFrame);
}

// ── Core pipeline setup (shared by getUserMedia + replaceTrack paths) ──
async function startPipeline(stream) {
  originalStream = stream;
  const track    = stream.getVideoTracks()[0];
  const settings = track.getSettings();
  const w = settings.width  || 1280;
  const h = settings.height || 720;

  outCanvas.width  = w;
  outCanvas.height = h;

  video.srcObject = stream;
  await video.play();

  initGL(w, h);
  initSegmenter();
  initFaceLandmarker();

  if (rafId) cancelAnimationFrame(rafId);
  renderFrame();

  const processed = outCanvas.captureStream(30);
  stream.getAudioTracks().forEach(t => processed.addTrack(t));
  console.log('[AIWebcam] Pipeline started', w, 'x', h);
  return processed;
}

// ── getUserMedia intercept ──
const _origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

navigator.mediaDevices.getUserMedia = async function (constraints) {
  console.log('[AIWebcam] getUserMedia called', JSON.stringify(constraints));
  const stream = await _origGetUserMedia(constraints);

  if (!constraints || !constraints.video || !state.pluginEnabled) {
    return stream;
  }

  try {
    const processed = await startPipeline(stream);
    return processed;
  } catch (err) {
    console.warn('[AIWebcam] Pipeline init failed:', err);
    return stream;
  }
};

// ── RTCRtpSender.replaceTrack intercept ──
// Jitsi and many WebRTC apps call replaceTrack() instead of a fresh getUserMedia
// for camera switches. We intercept it to pipe the new track through our pipeline.
const _origReplaceTrack = RTCRtpSender.prototype.replaceTrack;
RTCRtpSender.prototype.replaceTrack = async function (newTrack) {
  if (!newTrack || newTrack.kind !== 'video' || !state.pluginEnabled) {
    return _origReplaceTrack.call(this, newTrack);
  }
  console.log('[AIWebcam] replaceTrack intercepted, piping through pipeline');
  try {
    // Wrap the single track in a MediaStream so startPipeline can use it
    const fakeStream = new MediaStream([newTrack]);
    // Copy any audio from the existing originalStream
    if (originalStream) {
      originalStream.getAudioTracks().forEach(t => fakeStream.addTrack(t));
    }
    const processed = await startPipeline(fakeStream);
    const processedVideoTrack = processed.getVideoTracks()[0];
    return _origReplaceTrack.call(this, processedVideoTrack);
  } catch (err) {
    console.warn('[AIWebcam] replaceTrack pipeline failed:', err);
    return _origReplaceTrack.call(this, newTrack);
  }
};

// ── Listen for state updates from isolated bridge ──
window.addEventListener('awe:state', (e) => {
  const newState = e.detail;
  if (!newState) return;

  const wasEnabled = state.pluginEnabled;
  state = newState;

  if (wasEnabled && !state.pluginEnabled && rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  if (!wasEnabled && state.pluginEnabled && originalStream) {
    renderFrame();
  }
  // Trigger segmenter if now needed
  if (state.pluginEnabled && (state.background.mode !== 'none' || state.blur.enabled)) {
    initSegmenter();
  }
  if (state.pluginEnabled && state.beauty.enabled) {
    initFaceLandmarker();
  }
});

const AI_WEBCAM_BEAUTY_DEBUG_MESSAGE = '__AI_WEBCAM_BEAUTY_DEBUG__';

function setBeautyDebugMode(next) {
  window.__AIWebcamBeautyDebugMode = next;
  console.log('[AIWebcam] Beauty debug mode:', next === 1 ? 'mask' : next === 2 ? 'split' : 'off');
}

function broadcastBeautyDebugMode(next) {
  for (let i = 0; i < window.frames.length; i++) {
    try {
      window.frames[i].postMessage({ type: AI_WEBCAM_BEAUTY_DEBUG_MESSAGE, mode: next }, '*');
    } catch (_) {}
  }
  try {
    if (window.top && window.top !== window) {
      window.top.postMessage({ type: AI_WEBCAM_BEAUTY_DEBUG_MESSAGE, mode: next }, '*');
    }
  } catch (_) {}
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== AI_WEBCAM_BEAUTY_DEBUG_MESSAGE) return;
  setBeautyDebugMode(Number(data.mode) || 0);
  for (let i = 0; i < window.frames.length; i++) {
    try {
      if (window.frames[i] !== event.source) {
        window.frames[i].postMessage(data, '*');
      }
    } catch (_) {}
  }
});

window.__AIWebcamBeautyDebugMode = window.__AIWebcamBeautyDebugMode || 0;
window.__AIWebcamBeautyDebug = (mode) => {
  const map = { off: 0, mask: 1, split: 2 };
  const next = typeof mode === 'string' ? (map[mode] ?? 0) : Number(mode || 0);
  setBeautyDebugMode(next);
  broadcastBeautyDebugMode(next);
};

// Signal to isolated bridge that MAIN world script is loaded
window.dispatchEvent(new CustomEvent('awe:ready'));
console.log('[AIWebcam] Main world script loaded');
