/**
 * AI Webcam Effects — Isolated World Bridge (content.js)
 *
 * Runs in Chrome's ISOLATED content script world.
 * Responsibilities:
 *  1. Inject injected.bundle.js into the page's MAIN world (where getUserMedia lives)
 *  2. Load persisted state from chrome.storage and forward to MAIN world
 *  3. Listen for UPDATE_STATE messages from popup and forward to MAIN world
 *
 * Communication with MAIN world: window CustomEvents
 *   MAIN ← ISOLATED : 'awe:state'   (detail = state object)
 *   MAIN → ISOLATED : 'awe:ready'   (MAIN world signals it's up)
 */

const DEFAULT_STATE = {
  pluginEnabled: true,
  enhancer:   { enabled: false, level: 60 },
  background: { mode: 'none', color: '#1a1a2e', imageUrl: '' },
  watermark:  { enabled: false, text: 'My Watermark' },
  blur:       { enabled: false, level: 50 },
  beauty:     { enabled: false, level: 50 },
};

let currentState = JSON.parse(JSON.stringify(DEFAULT_STATE));

function dispatchStateToMainWorld(state) {
  window.dispatchEvent(new CustomEvent('awe:state', { detail: state }));
}

// Forward chrome messages → main world
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'UPDATE_STATE') {
    currentState = msg.state;
    dispatchStateToMainWorld(currentState);
  }
});

// Listen for ready signal from injected.js, then send persisted state
window.addEventListener('awe:ready', () => {
  chrome.storage.local.get('webcamEffectsState', (result) => {
    if (result.webcamEffectsState) {
      currentState = Object.assign({}, DEFAULT_STATE, result.webcamEffectsState);
    }
    dispatchStateToMainWorld(currentState);
  });
});
