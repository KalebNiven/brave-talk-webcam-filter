const sampleSelect = document.getElementById('sample-select');
const uploadInput = document.getElementById('upload-input');
const strengthInput = document.getElementById('strength-input');
const strengthValue = document.getElementById('strength-value');
const viewSelect = document.getElementById('view-select');
const runButton = document.getElementById('run-button');
const statusLine = document.getElementById('status-line');
const sampleMeta = document.getElementById('sample-meta');

const originalCanvas = document.getElementById('original-canvas');
const candidateACanvas = document.getElementById('candidate-a-canvas');
const candidateBCanvas = document.getElementById('candidate-b-canvas');
const candidateCCanvas = document.getElementById('candidate-c-canvas');

const metricsA = document.getElementById('candidate-a-metrics');
const metricsB = document.getElementById('candidate-b-metrics');
const metricsC = document.getElementById('candidate-c-metrics');

const MAX_DIMENSION = 900;
const FALLBACK_SAMPLES = [
  {
    id: 'manual-upload',
    title: 'Upload a face photo',
    file: '',
    sourcePage: '',
    license: 'Local file',
  },
];

let sampleManifest = [];
let currentImageBitmap = null;
let currentSourceMeta = null;
let latestBenchmarkRun = null;

function setStatus(text) {
  statusLine.textContent = text;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, t) {
  return a * (1 - t) + b * t;
}

function luma(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function ensureCanvasSize(canvas, width, height) {
  canvas.width = width;
  canvas.height = height;
}

function setMetrics(node, data) {
  node.innerHTML = [
    `Skin coverage: <strong>${data.skinCoverage}%</strong>`,
    `Blemish coverage: <strong>${data.blemishCoverage}%</strong>`,
    `Avg correction: <strong>${data.avgCorrection}</strong>`,
    `Sharpening preserved: <strong>${data.detailRetention}</strong>`,
  ].join('<br />');
}

function rgbaToYCbCr(r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b),
    cr: 128 + (0.5 * r - 0.418688 * g - 0.081312 * b),
  };
}

function skinMaskAt(data, i) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const { y, cb, cr } = rgbaToYCbCr(r, g, b);
  const cbMask = smoothStep(92, 108, cb) * (1 - smoothStep(154, 170, cb));
  const crMask = smoothStep(110, 122, cr) * (1 - smoothStep(182, 198, cr));
  const bright = smoothStep(18, 46, y);
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  const saturation = smoothStep(8, 24, spread);
  const warmth = smoothStep(3, 18, r - b);
  const baseSkin = cbMask * crMask * bright * saturation * warmth;
  const paleFallback = cbMask * crMask * smoothStep(42, 104, y) * smoothStep(1.5, 8, r - g) * smoothStep(2, 11, r - b) * smoothStep(26, 84, g) * (1 - smoothStep(16, 38, spread));
  const neutralCb = smoothStep(118, 124, cb) * (1 - smoothStep(132, 146, cb));
  const neutralCr = smoothStep(118, 124, cr) * (1 - smoothStep(132, 146, cr));
  const neutralFallback = neutralCb * neutralCr * smoothStep(34, 96, y) * (1 - smoothStep(156, 214, y)) * (1 - smoothStep(14, 46, spread));
  return clamp(Math.max(Math.max(baseSkin, paleFallback * 0.54), neutralFallback * 0.36), 0, 1);
}

function smoothStep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function boxBlur(data, width, height, radius, stride = 1) {
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      let count = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const sx = clamp(x + ox * stride, 0, width - 1);
          const sy = clamp(y + oy * stride, 0, height - 1);
          const si = (sy * width + sx) * 4;
          sr += data[si];
          sg += data[si + 1];
          sb += data[si + 2];
          sa += data[si + 3];
          count += 1;
        }
      }
      const di = (y * width + x) * 4;
      out[di] = sr / count;
      out[di + 1] = sg / count;
      out[di + 2] = sb / count;
    }
  }
  return out;
}

// Bilateral filter - edge-preserving smoothing
function bilateralFilter(data, width, height, skinMask, sigmaSpace, sigmaColor) {
  const output = new Uint8ClampedArray(data.length);
  const kernelRadius = 5; // 11x11 kernel

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = idx * 4;
      const skin = skinMask[idx];

      if (skin < 0.1) {
        // Not skin, copy original
        output[i] = data[i];
        output[i + 1] = data[i + 1];
        output[i + 2] = data[i + 2];
        output[i + 3] = data[i + 3];
        continue;
      }

      const centerLuma = luma(data[i], data[i + 1], data[i + 2]);
      let sumR = 0, sumG = 0, sumB = 0;
      let weightSum = 0;

      for (let ky = -kernelRadius; ky <= kernelRadius; ky++) {
        for (let kx = -kernelRadius; kx <= kernelRadius; kx++) {
          const sx = clamp(x + kx, 0, width - 1);
          const sy = clamp(y + ky, 0, height - 1);
          const sIdx = sy * width + sx;
          const si = sIdx * 4;

          // Spatial Gaussian weight
          const spatialDist = Math.sqrt(kx * kx + ky * ky);
          const spatialWeight = Math.exp(-(spatialDist * spatialDist) / (2 * sigmaSpace * sigmaSpace));

          // Color Gaussian weight (based on luminance difference)
          const sampleLuma = luma(data[si], data[si + 1], data[si + 2]);
          const colorDist = Math.abs(sampleLuma - centerLuma);
          const colorWeight = Math.exp(-(colorDist * colorDist) / (2 * sigmaColor * sigmaColor));

          // Combined weight
          const weight = spatialWeight * colorWeight * skin;

          sumR += data[si] * weight;
          sumG += data[si + 1] * weight;
          sumB += data[si + 2] * weight;
          weightSum += weight;
        }
      }

      if (weightSum > 0) {
        output[i] = sumR / weightSum;
        output[i + 1] = sumG / weightSum;
        output[i + 2] = sumB / weightSum;
      } else {
        output[i] = data[i];
        output[i + 1] = data[i + 1];
        output[i + 2] = data[i + 2];
      }
      output[i + 3] = data[i + 3];
    }
  }

  return output;
}

function blurMask(mask, width, height, radius, stride = 1) {
  const out = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let oy = -radius; oy <= radius; oy++) {
        for (let ox = -radius; ox <= radius; ox++) {
          const sx = clamp(x + ox * stride, 0, width - 1);
          const sy = clamp(y + oy * stride, 0, height - 1);
          sum += mask[sy * width + sx];
          count += 1;
        }
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

function computeMasks(data, width, height, strength) {
  const local = boxBlur(data, width, height, 4, 2);
  const soft = boxBlur(data, width, height, 2, 1);
  const strong = boxBlur(data, width, height, 4, 3);
  const skinMask = new Float32Array(width * height);
  const blemishMask = new Float32Array(width * height);
  const lowContrastMask = new Float32Array(width * height);
  const textureMask = new Float32Array(width * height);
  const clusterSeed = new Float32Array(width * height);
  const edgeMask = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = idx * 4;
      const pixelSkin = skinMaskAt(data, i);
      const avgSkin = skinMaskAt(local, i);
      const pixelLuma = luma(data[i], data[i + 1], data[i + 2]);
      const avgLuma = luma(local[i], local[i + 1], local[i + 2]);
      const pixelSpread = Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      const avgSpread = Math.max(local[i], local[i + 1], local[i + 2]) - Math.min(local[i], local[i + 1], local[i + 2]);
      const neutralSkin = smoothStep(30, 92, avgLuma) * (1 - smoothStep(154, 214, avgLuma)) * (1 - smoothStep(12, 42, pixelSpread + avgSpread * 0.6)) * (1 - smoothStep(10, 34, Math.abs(pixelLuma - avgLuma)));
      const skinColor = Math.max(pixelSkin, avgSkin * 0.8) * smoothStep(0.13, 0.36, pixelSkin + avgSkin * 0.92);
      const skin = clamp(Math.max(skinColor, neutralSkin * 0.58), 0, 1);
      const centerRed = data[i] - 0.5 * (data[i + 1] + data[i + 2]);
      const avgRed = local[i] - 0.5 * (local[i + 1] + local[i + 2]);
      const redExcess = Math.max(0, centerRed - avgRed);
      const threshold = mix(5, 1.5, strength);
      const redBlemish = smoothStep(threshold, threshold * 2.8, redExcess);
      const absRed = data[i] - (data[i + 1] + data[i + 2]) * 0.5;
      const absRedSignal = smoothStep(mix(4, 1, strength), mix(14, 6, strength), absRed);

      const textureDelta = (
        Math.abs(data[i] - soft[i]) +
        Math.abs(data[i + 1] - soft[i + 1]) +
        Math.abs(data[i + 2] - soft[i + 2])
      ) / 3;
      const localDelta = (
        Math.abs(data[i] - local[i]) +
        Math.abs(data[i + 1] - local[i + 1]) +
        Math.abs(data[i + 2] - local[i + 2])
      ) / 3;
      const fineTexture = smoothStep(3, 12, textureDelta) * (1 - smoothStep(38, 66, textureDelta));
      const roughTexture = smoothStep(3, 12, localDelta) * (1 - smoothStep(56, 96, localDelta));
      const texture = Math.max(fineTexture, roughTexture * 0.85);
      const centerPink = (data[i] - data[i + 1]) * 0.75 + (data[i + 2] - data[i + 1]) * 0.35;
      const avgPink = (local[i] - local[i + 1]) * 0.75 + (local[i + 2] - local[i + 1]) * 0.35;
      const pinkExcess = Math.max(0, centerPink - avgPink * 0.92);
      const chromaDrift = (
        Math.abs((data[i] - data[i + 1]) - (local[i] - local[i + 1])) +
        Math.abs((data[i] - data[i + 2]) - (local[i] - local[i + 2]))
      ) * 0.5;
      const left = ((y * width) + clamp(x - 1, 0, width - 1)) * 4;
      const right = ((y * width) + clamp(x + 1, 0, width - 1)) * 4;
      const up = ((clamp(y - 1, 0, height - 1) * width) + x) * 4;
      const down = ((clamp(y + 1, 0, height - 1) * width) + x) * 4;
      const edge = Math.abs(luma(data[left], data[left + 1], data[left + 2]) - luma(data[right], data[right + 1], data[right + 2])) +
        Math.abs(luma(data[up], data[up + 1], data[up + 2]) - luma(data[down], data[down + 1], data[down + 2]));
      const edgeReject = 1 - smoothStep(12, 34, edge);
      const lowContrastSeed = smoothStep(mix(3, 1, strength), mix(10, 4, strength), chromaDrift);
      const pinkBlemish = smoothStep(mix(2.5, 0.8, strength), mix(8, 3, strength), pinkExcess + textureDelta * 0.5);
      const lowContrastSupport = smoothStep(0.08, 0.32, roughTexture * 0.92 + redBlemish * 0.82 + absRedSignal * 0.7 + skin * 0.15) * (0.45 + 0.55 * edgeReject);
      const lowContrastBlemish = lowContrastSeed * pinkBlemish * lowContrastSupport * smoothStep(0.10, 0.34, skin + avgSkin * 0.9);
      const textureBlemish = roughTexture * smoothStep(0.08, 0.22, skin) * edgeReject;
      const blemish = Math.max(redBlemish, Math.max(absRedSignal * 0.92, Math.max(lowContrastBlemish * 0.88, textureBlemish * 0.85)));

      skinMask[idx] = skin;
      blemishMask[idx] = blemish;
      lowContrastMask[idx] = lowContrastBlemish;
      textureMask[idx] = texture;
      const textureSupport = texture * smoothStep(0.08, 0.28, redBlemish * 0.7 + lowContrastBlemish * 0.9 + roughTexture * 0.55 + absRedSignal * 0.6);
      clusterSeed[idx] = Math.max(Math.max(redBlemish * 1.58, Math.max(lowContrastBlemish * 1.18, absRedSignal * 1.3)), textureSupport * 0.58) * skin * (0.28 + 0.72 * edgeReject);
      edgeMask[idx] = edgeReject;
    }
  }

  const clusterBlur = blurMask(clusterSeed, width, height, 5, 2);
  const regionBlur = blurMask(clusterSeed, width, height, 12, 4);
  const clusterMask = new Float32Array(width * height);
  const regionMask = new Float32Array(width * height);
  for (let idx = 0; idx < width * height; idx++) {
    clusterMask[idx] = smoothStep(0.015, 0.06, clusterBlur[idx]) * skinMask[idx];
    regionMask[idx] = smoothStep(0.008, 0.03, regionBlur[idx]) * skinMask[idx];
  }

  return { local, soft, strong, skinMask, blemishMask, lowContrastMask, textureMask, clusterMask, regionMask, edgeMask };
}

function applyCandidateA(data, width, height, strength, viewMode) {
  const { local, skinMask, blemishMask, edgeMask } = computeMasks(data, width, height, strength);
  const processed = new Uint8ClampedArray(data.length);
  const mask = new Uint8ClampedArray(data.length);
  let skinPixels = 0;
  let blemishPixels = 0;
  let correctionSum = 0;
  let detailSum = 0;

  for (let idx = 0; idx < width * height; idx++) {
    const i = idx * 4;
    const skin = skinMask[idx];
    const blemish = blemishMask[idx] * skin * edgeMask[idx];
    if (skin > 0.18) skinPixels += 1;
    if (blemish > 0.18) blemishPixels += 1;

    mask[i] = Math.round(255 * blemish);
    mask[i + 1] = Math.round(255 * skin * edgeMask[idx]);
    mask[i + 2] = 0;
    mask[i + 3] = 255;

    const targetR = mix(data[i], local[i], 0.45 + 0.25 * strength);
    const targetG = mix(data[i + 1], local[i + 1], 0.18 + 0.1 * strength);
    const targetB = mix(data[i + 2], local[i + 2], 0.18 + 0.1 * strength);
    const amount = blemish * (0.55 + 0.35 * strength);

    processed[i] = mix(data[i], targetR, amount);
    processed[i + 1] = mix(data[i + 1], targetG, amount);
    processed[i + 2] = mix(data[i + 2], targetB, amount);
    processed[i + 3] = data[i + 3];

    correctionSum += amount;
    detailSum += edgeMask[idx];
  }

  return {
    pixels: renderCandidateView(data, processed, mask, width, height, viewMode),
    metrics: summarizeMetrics(width, height, skinPixels, blemishPixels, correctionSum, detailSum),
  };
}

function applyCandidateB(data, width, height, strength, viewMode) {
  const { local, soft, strong, skinMask, blemishMask, edgeMask } = computeMasks(data, width, height, strength);
  const processed = new Uint8ClampedArray(data.length);
  const mask = new Uint8ClampedArray(data.length);
  let skinPixels = 0;
  let blemishPixels = 0;
  let correctionSum = 0;
  let detailSum = 0;

  for (let idx = 0; idx < width * height; idx++) {
    const i = idx * 4;
    const skin = skinMask[idx];
    const blemish = blemishMask[idx] * skin;
    const edge = edgeMask[idx];
    if (skin > 0.18) skinPixels += 1;
    if (blemish > 0.18) blemishPixels += 1;

    mask[i] = Math.round(255 * blemish);
    mask[i + 1] = Math.round(255 * skin * edge);
    mask[i + 2] = 0;
    mask[i + 3] = 255;

    const baseAmount = skin * edge * (0.05 + 0.08 * strength);
    const blemishAmount = blemish * edge * (0.62 + 0.28 * strength);
    const baseR = mix(data[i], soft[i], baseAmount);
    const baseG = mix(data[i + 1], soft[i + 1], baseAmount);
    const baseB = mix(data[i + 2], soft[i + 2], baseAmount);
    const targetR = mix(strong[i], local[i], 0.58);
    const targetG = mix(strong[i + 1], local[i + 1], 0.48);
    const targetB = mix(strong[i + 2], local[i + 2], 0.48);

    processed[i] = mix(baseR, targetR, blemishAmount);
    processed[i + 1] = mix(baseG, targetG, blemishAmount);
    processed[i + 2] = mix(baseB, targetB, blemishAmount);
    processed[i + 3] = data[i + 3];

    correctionSum += baseAmount + blemishAmount;
    detailSum += edge;
  }

  return {
    pixels: renderCandidateView(data, processed, mask, width, height, viewMode),
    metrics: summarizeMetrics(width, height, skinPixels, blemishPixels, correctionSum, detailSum),
  };
}

// Calculate texture roughness (variance from local average) for adaptive smoothing
// Only measures roughness WITHIN skin areas, excludes edges
function calculateTextureRoughness(data, width, height, skinMask) {
  const roughness = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const i = idx * 4;
      const skin = skinMask[idx];

      // Skip if not on skin
      if (skin < 0.2) {
        roughness[idx] = 0;
        continue;
      }

      // Small blur for local average (5x5) - only skin pixels
      let avgLuma = 0;
      let skinSum = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          const sy = clamp(y + ky, 0, height - 1);
          const sx = clamp(x + kx, 0, width - 1);
          const sIdx = sy * width + sx;
          const si = sIdx * 4;
          const sampleSkin = skinMaskAt(data, si);
          avgLuma += luma(data[si], data[si + 1], data[si + 2]) * sampleSkin;
          skinSum += sampleSkin;
        }
      }

      // Only proceed if we have enough skin neighbors
      if (skinSum < 5) {
        roughness[idx] = 0;
        continue;
      }
      avgLuma /= skinSum;

      // Measure local variance - only from skin pixels
      let variance = 0;
      let skinWeightSum = 0;
      for (let ky = -2; ky <= 2; ky++) {
        for (let kx = -2; kx <= 2; kx++) {
          const sy = clamp(y + ky, 0, height - 1);
          const sx = clamp(x + kx, 0, width - 1);
          const sIdx = sy * width + sx;
          const si = sIdx * 4;
          const sampleSkin = skinMaskAt(data, si);
          if (sampleSkin > 0.1) {
            const diff = luma(data[si], data[si + 1], data[si + 2]) - avgLuma;
            variance += diff * diff * sampleSkin;
            skinWeightSum += sampleSkin;
          }
        }
      }

      if (skinWeightSum < 1) {
        roughness[idx] = 0;
        continue;
      }
      variance /= skinWeightSum;

      // Lower threshold since we're only measuring on skin
      roughness[idx] = smoothStep(0.0005 * 65025, 0.004 * 65025, variance);
    }
  }

  return roughness;
}

function applyCandidateC(data, width, height, strength, viewMode) {
  const {
    local,
    soft,
    strong,
    skinMask,
    blemishMask,
    lowContrastMask,
    textureMask,
    clusterMask,
    regionMask,
    edgeMask,
  } = computeMasks(data, width, height, strength);
  const processed = new Uint8ClampedArray(data.length);
  const mask = new Uint8ClampedArray(data.length);
  let skinPixels = 0;
  let blemishPixels = 0;
  let correctionSum = 0;
  let detailSum = 0;

  for (let idx = 0; idx < width * height; idx++) {
    const i = idx * 4;
    const skin = skinMask[idx];
    const edge = edgeMask[idx];
    const region = regionMask[idx];
    const cluster = clusterMask[idx];
    const texture = textureMask[idx];
    const spotCore = Math.max(blemishMask[idx], lowContrastMask[idx] * 1.08);
    const spotSeed = Math.max(spotCore * (0.92 + cluster * 0.12), cluster * (0.52 + spotCore * 0.38));
    const regionFloor = region * skin * edge * 0.25;
    const rawSpot = Math.max(spotSeed * (0.84 + region * 0.16), regionFloor);
    const spot = clamp(rawSpot * smoothStep(0.06, 0.22, skin + region * 0.5), 0, 1);
    const protectedDetail = clamp((0.14 + texture * (0.52 + edge * 0.48)) * (1 - spot * (0.34 + 0.12 * strength)), 0, 1);

    if (skin > 0.18) skinPixels += 1;
    if (spot > 0.02) blemishPixels += 1;

    mask[i] = Math.round(255 * spot);
    mask[i + 1] = Math.round(255 * skin * edge);
    mask[i + 2] = Math.round(255 * protectedDetail);
    mask[i + 3] = 255;

    const baseAmount = skin * edge * (0.035 + 0.065 * strength) * (0.32 + region * 0.68);
    const spotAmount = spot * (0.32 + 0.24 * strength);
    const toneAmount = spot * (0.18 + 0.16 * strength);
    const finishAmount = skin * region * edge * (0.014 + 0.032 * strength) * (0.34 + spot * 0.46);

    const baseR = mix(data[i], soft[i], baseAmount);
    const baseG = mix(data[i + 1], soft[i + 1], baseAmount);
    const baseB = mix(data[i + 2], soft[i + 2], baseAmount);

    const lowFreqR = mix(local[i], strong[i], 0.38 + 0.26 * spot);
    const lowFreqG = mix(local[i + 1], strong[i + 1], 0.28 + 0.18 * spot);
    const lowFreqB = mix(local[i + 2], strong[i + 2], 0.28 + 0.18 * spot);

    const correctedR = mix(baseR, lowFreqR, spotAmount);
    const correctedG = mix(baseG, lowFreqG, spotAmount);
    const correctedB = mix(baseB, lowFreqB, spotAmount);

    const restoredR = clamp(correctedR + (data[i] - soft[i]) * protectedDetail * 0.96, 0, 255);
    const restoredG = clamp(correctedG + (data[i + 1] - soft[i + 1]) * protectedDetail * 0.96, 0, 255);
    const restoredB = clamp(correctedB + (data[i + 2] - soft[i + 2]) * protectedDetail * 0.96, 0, 255);

    const tonedR = mix(restoredR, Math.min(restoredR, local[i] * (0.985 + 0.025 * (1 - strength))), toneAmount);
    const tonedG = mix(restoredG, mix(restoredG, local[i + 1], 0.16), toneAmount * 0.55);
    const tonedB = mix(restoredB, mix(restoredB, local[i + 2], 0.12), toneAmount * 0.55);

    processed[i] = clamp(mix(tonedR, soft[i], finishAmount), 0, 255);
    processed[i + 1] = clamp(mix(tonedG, soft[i + 1], finishAmount), 0, 255);
    processed[i + 2] = clamp(mix(tonedB, soft[i + 2], finishAmount), 0, 255);
    processed[i + 3] = data[i + 3];

    correctionSum += baseAmount + spotAmount + toneAmount + finishAmount;
    detailSum += protectedDetail;
  }

  return {
    pixels: renderCandidateView(data, processed, mask, width, height, viewMode),
    metrics: summarizeMetrics(width, height, skinPixels, blemishPixels, correctionSum, detailSum),
  };
}

function summarizeMetrics(width, height, skinPixels, blemishPixels, correctionSum, detailSum) {
  const total = width * height;
  return {
    skinCoverage: ((skinPixels / total) * 100).toFixed(1),
    blemishCoverage: ((blemishPixels / total) * 100).toFixed(1),
    avgCorrection: (correctionSum / total).toFixed(3),
    detailRetention: (detailSum / total).toFixed(3),
  };
}

function renderCandidateView(original, processed, mask, width, height, viewMode) {
  if (viewMode === 'mask') return mask;
  if (viewMode === 'processed') return processed;

  const out = new Uint8ClampedArray(original.length);
  const splitX = Math.floor(width * 0.5);
  for (let idx = 0; idx < width * height; idx++) {
    const x = idx % width;
    const i = idx * 4;
    if (viewMode === 'split') {
      if (Math.abs(x - splitX) <= 1) {
        out[i] = 0;
        out[i + 1] = 255;
        out[i + 2] = 255;
        out[i + 3] = 255;
        continue;
      }
      const source = x < splitX ? original : processed;
      out[i] = source[i];
      out[i + 1] = source[i + 1];
      out[i + 2] = source[i + 2];
      out[i + 3] = source[i + 3];
      continue;
    }

    out[i] = clamp(Math.abs(processed[i] - original[i]) * 6, 0, 255);
    out[i + 1] = clamp(Math.abs(processed[i + 1] - original[i + 1]) * 6, 0, 255);
    out[i + 2] = clamp(Math.abs(processed[i + 2] - original[i + 2]) * 6, 0, 255);
    out[i + 3] = 255;
  }

  return out;
}

function drawPixels(canvas, pixels, width, height) {
  ensureCanvasSize(canvas, width, height);
  const ctx = canvas.getContext('2d');
  const imageData = new ImageData(pixels, width, height);
  ctx.putImageData(imageData, 0, 0);
}

function drawBitmapToCanvas(bitmap, canvas) {
  const { width, height } = fitDimensions(bitmap.width, bitmap.height, MAX_DIMENSION);
  ensureCanvasSize(canvas, width, height);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
}

function fitDimensions(width, height, maxDimension) {
  const ratio = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function extractImageData(bitmap) {
  const { width, height } = fitDimensions(bitmap.width, bitmap.height, MAX_DIMENSION);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return imageData;
}

async function fetchManifest() {
  try {
    const response = await fetch('./samples/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('manifest missing');
    const manifest = await response.json();
    return [...manifest, ...FALLBACK_SAMPLES];
  } catch (_) {
    return [...FALLBACK_SAMPLES];
  }
}

function populateSelect(samples) {
  sampleSelect.innerHTML = '';
  for (const sample of samples) {
    const option = document.createElement('option');
    option.value = sample.id;
    option.textContent = sample.title;
    sampleSelect.appendChild(option);
  }
}

async function loadImageFromUrl(url) {
  const img = new Image();
  img.decoding = 'async';
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return createImageBitmap(img);
}

async function loadSelectedSample() {
  const selected = sampleManifest.find((sample) => sample.id === sampleSelect.value);
  currentSourceMeta = selected || null;
  if (!selected || !selected.file) {
    currentImageBitmap = null;
    sampleMeta.textContent = selected ? `Source: ${selected.license}` : '';
    clearResults();
    return;
  }
  setStatus(`Loading ${selected.title}…`);
  currentImageBitmap = await loadImageFromUrl(selected.file);
  sampleMeta.innerHTML = `Source: <a href="${selected.sourcePage}" target="_blank" rel="noreferrer">${selected.license}</a>`;
  drawBitmapToCanvas(currentImageBitmap, originalCanvas);
  setStatus(`Loaded ${selected.title}`);
}

function clearResults() {
  for (const canvas of [originalCanvas, candidateACanvas, candidateBCanvas, candidateCCanvas]) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  metricsA.textContent = '';
  metricsB.textContent = '';
  metricsC.textContent = '';
}

async function handleUpload(event) {
  const [file] = event.target.files || [];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  currentImageBitmap = bitmap;
  currentSourceMeta = { title: file.name, sourcePage: '', license: 'Local file' };
  sampleSelect.value = 'manual-upload';
  sampleMeta.textContent = `Source: Local file • ${file.name}`;
  drawBitmapToCanvas(bitmap, originalCanvas);
  setStatus(`Loaded local photo: ${file.name}`);
}

function runBenchmark() {
  if (!currentImageBitmap) {
    setStatus('Select or upload a photo first.');
    latestBenchmarkRun = null;
    return null;
  }

  const strength = Number(strengthInput.value) / 100;
  const viewMode = viewSelect.value;
  const imageData = extractImageData(currentImageBitmap);
  const { data, width, height } = imageData;

  drawPixels(originalCanvas, data, width, height);
  const a = applyCandidateA(data, width, height, strength, viewMode);
  const b = applyCandidateB(data, width, height, strength, viewMode);
  const c = applyCandidateC(data, width, height, strength, viewMode);

  drawPixels(candidateACanvas, a.pixels, width, height);
  drawPixels(candidateBCanvas, b.pixels, width, height);
  drawPixels(candidateCCanvas, c.pixels, width, height);
  setMetrics(metricsA, a.metrics);
  setMetrics(metricsB, b.metrics);
  setMetrics(metricsC, c.metrics);
  const sourceName = currentSourceMeta?.title || 'current image';
  setStatus(`Benchmark complete for ${sourceName}`);
  latestBenchmarkRun = {
    sourceName,
    sourceId: currentSourceMeta?.id || sampleSelect.value,
    strength,
    strengthPercent: Number(strengthInput.value),
    viewMode,
    width,
    height,
    candidates: {
      a: a.metrics,
      b: b.metrics,
      c: c.metrics,
    },
    canvases: {
      original: getCanvasSnapshot(originalCanvas),
      candidateA: getCanvasSnapshot(candidateACanvas),
      candidateB: getCanvasSnapshot(candidateBCanvas),
      candidateC: getCanvasSnapshot(candidateCCanvas),
    },
  };
  return latestBenchmarkRun;
}

function getCanvasSnapshot(canvas) {
  return {
    width: canvas.width,
    height: canvas.height,
    dataUrl: canvas.width && canvas.height ? canvas.toDataURL('image/png') : null,
  };
}

function getAutomationState() {
  return {
    status: statusLine.textContent,
    currentSampleId: sampleSelect.value,
    currentSourceMeta,
    hasImage: Boolean(currentImageBitmap),
    availableSamples: sampleManifest.map(({ id, title }) => ({ id, title })),
    latestBenchmarkRun,
  };
}

function setStrengthForAutomation(value) {
  const nextValue = String(clamp(Math.round(Number(value)), 0, 100));
  strengthInput.value = nextValue;
  strengthValue.textContent = nextValue;
  return Number(nextValue);
}

function setViewModeForAutomation(value) {
  const allowed = ['processed', 'mask', 'split', 'difference'];
  const nextValue = allowed.includes(value) ? value : 'processed';
  viewSelect.value = nextValue;
  return nextValue;
}

async function selectSampleForAutomation(sampleId) {
  if (!sampleManifest.some((sample) => sample.id === sampleId)) {
    throw new Error(`Unknown sample: ${sampleId}`);
  }
  sampleSelect.value = sampleId;
  await loadSelectedSample();
  return getAutomationState();
}

async function runBenchmarkForAutomation(options = {}) {
  if (typeof options.sampleId === 'string' && options.sampleId) {
    await selectSampleForAutomation(options.sampleId);
  }
  if (options.strength !== undefined) {
    setStrengthForAutomation(options.strength);
  }
  if (options.viewMode !== undefined) {
    setViewModeForAutomation(options.viewMode);
  }
  const result = runBenchmark();
  return result || latestBenchmarkRun;
}

window.__AWE_BENCHMARK__ = {
  getState: getAutomationState,
  listSamples: () => sampleManifest.map(({ id, title }) => ({ id, title })),
  selectSample: selectSampleForAutomation,
  setStrength: setStrengthForAutomation,
  setViewMode: setViewModeForAutomation,
  run: runBenchmarkForAutomation,
};

function getAutomationOutputNode() {
  let node = document.getElementById('automation-output');
  if (node) return node;
  node = document.createElement('pre');
  node.id = 'automation-output';
  node.style.whiteSpace = 'pre-wrap';
  node.style.wordBreak = 'break-word';
  node.style.display = 'none';
  document.body.appendChild(node);
  return node;
}

function setAutomationOutput(payload, status) {
  const node = getAutomationOutputNode();
  node.dataset.status = status;
  node.textContent = JSON.stringify(payload, null, 2);
  document.body.dataset.automationStatus = status;
  document.body.dataset.automationReady = 'true';
}

function sanitizeAutomationResult(result, includeCanvases) {
  if (!result || includeCanvases) return result;
  const { canvases, ...rest } = result;
  return rest;
}

async function maybeAutorunFromQuery() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('autorun') !== '1') return;
  const sampleId = params.get('sample') || sampleSelect.value;
  const strength = params.get('strength');
  const viewMode = params.get('view') || 'processed';
  const includeCanvases = params.get('includeCanvases') === '1';
  try {
    const result = await runBenchmarkForAutomation({
      sampleId,
      strength: strength == null ? undefined : Number(strength),
      viewMode,
    });
    setAutomationOutput({
      ok: true,
      result: sanitizeAutomationResult(result, includeCanvases),
    }, 'done');
  } catch (error) {
    setStatus(`Autorun failed: ${error.message}`);
    setAutomationOutput({
      ok: false,
      error: error.message,
      state: getAutomationState(),
    }, 'error');
  }
}

strengthInput.addEventListener('input', () => {
  strengthValue.textContent = strengthInput.value;
});

sampleSelect.addEventListener('change', async () => {
  try {
    await loadSelectedSample();
    if (currentImageBitmap) runBenchmark();
  } catch (error) {
    setStatus(`Failed to load sample: ${error.message}`);
  }
});

uploadInput.addEventListener('change', async (event) => {
  try {
    await handleUpload(event);
    runBenchmark();
  } catch (error) {
    setStatus(`Upload failed: ${error.message}`);
  }
});

runButton.addEventListener('click', () => {
  runBenchmark();
});

viewSelect.addEventListener('change', () => {
  if (currentImageBitmap) runBenchmark();
});

strengthInput.addEventListener('change', () => {
  if (currentImageBitmap) runBenchmark();
});

(async function init() {
  setStatus('Loading sample manifest…');
  sampleManifest = await fetchManifest();
  populateSelect(sampleManifest);
  sampleSelect.value = sampleManifest[0]?.id || '';
  strengthValue.textContent = strengthInput.value;
  if (sampleSelect.value && sampleSelect.value !== 'manual-upload') {
    try {
      await loadSelectedSample();
      runBenchmark();
    } catch (error) {
      setStatus(`Unable to load starter sample: ${error.message}`);
    }
  } else {
    setStatus('Upload a photo or download starter samples to begin.');
  }
  await maybeAutorunFromQuery();
})();
