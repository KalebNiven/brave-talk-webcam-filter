const DEFAULT_STATE = {
  pluginEnabled: true,
  enhancer: { enabled: false, level: 60 },
  background: { mode: 'none', color: '#1a1a2e', imageUrl: '' },
  watermark: { enabled: false, text: 'My Watermark' },
  blur: { enabled: false, level: 50 },
  beauty: { enabled: false, level: 50 },
};

let state = JSON.parse(JSON.stringify(DEFAULT_STATE));

// ── DOM refs ──
const pluginPowerBtn   = document.getElementById('plugin-power');
const pluginStatusLbl  = document.getElementById('plugin-status-label');
const effectsBody      = document.getElementById('effects-body');

const toggleEnhancer   = document.getElementById('toggle-enhancer');
const enhancerSliderRow = document.getElementById('enhancer-slider-row');
const enhancerLevel    = document.getElementById('enhancer-level');

const bgHeader         = document.getElementById('bg-header');
const bgArrow          = document.getElementById('bg-arrow');
const bgBody           = document.getElementById('bg-body');
const bgSelect         = document.getElementById('bg-select');
const bgCurrentLabel   = document.getElementById('bg-current-label');
const bgColorRow       = document.getElementById('bg-color-row');
const bgColorPicker    = document.getElementById('bg-color-picker');
const bgImageRow       = document.getElementById('bg-image-row');
const bgImageUrl       = document.getElementById('bg-image-url');

const toggleWatermark  = document.getElementById('toggle-watermark');
const watermarkTextRow = document.getElementById('watermark-text-row');
const watermarkText    = document.getElementById('watermark-text');

const toggleBlur       = document.getElementById('toggle-blur');
const blurSliderRow    = document.getElementById('blur-slider-row');
const blurLevel        = document.getElementById('blur-level');

const toggleBeauty     = document.getElementById('toggle-beauty');
const beautySliderRow  = document.getElementById('beauty-slider-row');
const beautyLevel      = document.getElementById('beauty-level');

// ── Helpers ──
function updateRangeTrack(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--pct', pct + '%');
  input.style.background = `linear-gradient(to right, #3b9eff ${pct}%, #ddd ${pct}%)`;
}

function sendToContent(msg) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
    }
  });
}

function saveAndSend() {
  chrome.storage.local.set({ webcamEffectsState: state });
  sendToContent({ type: 'UPDATE_STATE', state });
}

// ── Apply state to UI ──
function applyStateToUI() {
  const on = state.pluginEnabled;
  pluginPowerBtn.classList.toggle('active', on);
  pluginStatusLbl.textContent = on ? 'Plugin is ON' : 'Plugin is OFF';
  pluginStatusLbl.className   = 'status-label ' + (on ? 'on' : 'off');
  effectsBody.classList.toggle('disabled', !on);

  toggleEnhancer.checked = state.enhancer.enabled;
  enhancerSliderRow.style.display = state.enhancer.enabled ? '' : 'none';
  enhancerLevel.value = state.enhancer.level;
  updateRangeTrack(enhancerLevel);

  bgSelect.value = state.background.mode;
  bgCurrentLabel.textContent = capitalize(state.background.mode);
  bgColorPicker.value = state.background.color;
  bgImageUrl.value    = state.background.imageUrl;
  updateBgExtras(state.background.mode);

  toggleWatermark.checked       = state.watermark.enabled;
  watermarkTextRow.style.display = state.watermark.enabled ? '' : 'none';
  watermarkText.value            = state.watermark.text;

  toggleBlur.checked      = state.blur.enabled;
  blurSliderRow.style.display = state.blur.enabled ? '' : 'none';
  blurLevel.value             = state.blur.level;
  updateRangeTrack(blurLevel);

  toggleBeauty.checked       = state.beauty.enabled;
  beautySliderRow.style.display = state.beauty.enabled ? '' : 'none';
  beautyLevel.value             = state.beauty.level;
  updateRangeTrack(beautyLevel);
}

function capitalize(s) {
  if (!s) return 'None';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function updateBgExtras(mode) {
  bgColorRow.style.display = mode === 'color' ? '' : 'none';
  bgImageRow.style.display = mode === 'image' ? '' : 'none';
}

// ── Event listeners ──

// Plugin power
pluginPowerBtn.addEventListener('click', () => {
  state.pluginEnabled = !state.pluginEnabled;
  applyStateToUI();
  saveAndSend();
});

// Enhancer
toggleEnhancer.addEventListener('change', () => {
  state.enhancer.enabled = toggleEnhancer.checked;
  enhancerSliderRow.style.display = state.enhancer.enabled ? '' : 'none';
  saveAndSend();
});
enhancerLevel.addEventListener('input', () => {
  state.enhancer.level = parseInt(enhancerLevel.value);
  updateRangeTrack(enhancerLevel);
  saveAndSend();
});

// Background collapsible
let bgOpen = false;
bgHeader.addEventListener('click', () => {
  bgOpen = !bgOpen;
  bgBody.style.display = bgOpen ? '' : 'none';
  bgArrow.classList.toggle('open', bgOpen);
});
bgBody.style.display = 'none'; // start collapsed

bgSelect.addEventListener('change', () => {
  state.background.mode = bgSelect.value;
  bgCurrentLabel.textContent = capitalize(bgSelect.value);
  updateBgExtras(bgSelect.value);
  saveAndSend();
});
bgColorPicker.addEventListener('input', () => {
  state.background.color = bgColorPicker.value;
  saveAndSend();
});
bgImageUrl.addEventListener('change', () => {
  state.background.imageUrl = bgImageUrl.value.trim();
  saveAndSend();
});

// Watermark
toggleWatermark.addEventListener('change', () => {
  state.watermark.enabled = toggleWatermark.checked;
  watermarkTextRow.style.display = state.watermark.enabled ? '' : 'none';
  saveAndSend();
});
watermarkText.addEventListener('input', () => {
  state.watermark.text = watermarkText.value;
  saveAndSend();
});

// Blur
toggleBlur.addEventListener('change', () => {
  state.blur.enabled = toggleBlur.checked;
  blurSliderRow.style.display = state.blur.enabled ? '' : 'none';
  saveAndSend();
});
blurLevel.addEventListener('input', () => {
  state.blur.level = parseInt(blurLevel.value);
  updateRangeTrack(blurLevel);
  saveAndSend();
});

// Beauty
toggleBeauty.addEventListener('change', () => {
  state.beauty.enabled = toggleBeauty.checked;
  beautySliderRow.style.display = state.beauty.enabled ? '' : 'none';
  saveAndSend();
});
beautyLevel.addEventListener('input', () => {
  state.beauty.level = parseInt(beautyLevel.value);
  updateRangeTrack(beautyLevel);
  saveAndSend();
});

// ── Init: load persisted state ──
chrome.storage.local.get('webcamEffectsState', (result) => {
  if (result.webcamEffectsState) {
    state = Object.assign({}, DEFAULT_STATE, result.webcamEffectsState);
    state.enhancer    = Object.assign({}, DEFAULT_STATE.enhancer, state.enhancer);
    state.background  = Object.assign({}, DEFAULT_STATE.background, state.background);
    state.watermark   = Object.assign({}, DEFAULT_STATE.watermark, state.watermark);
    state.blur        = Object.assign({}, DEFAULT_STATE.blur, state.blur);
    state.beauty      = Object.assign({}, DEFAULT_STATE.beauty, state.beauty);
  }
  applyStateToUI();
});
