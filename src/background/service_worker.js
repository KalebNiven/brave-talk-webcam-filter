// Service worker — injects the MAIN world script on navigation,
// relays popup → content messages.

chrome.runtime.onInstalled.addListener(() => {
  console.log('[AIWebcam] Extension installed.');
});

// Inject the MAIN world pipeline script + wasmBase at document_start
// This fires before any page JS, guaranteeing the getUserMedia override is in place.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (!details.url || details.url.startsWith('chrome') || details.url.startsWith('about')) return;

  try {
    const wasmBase = chrome.runtime.getURL('lib/mediapipe/wasm');

    // 1. Set wasmBase in MAIN world
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      func: (wb) => { window.__aweWasmBase = wb; },
      args: [wasmBase],
      injectImmediately: true,
    });

    // 2. Inject the pipeline bundle into MAIN world
    await chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [details.frameId] },
      world: 'MAIN',
      files: ['injected.bundle.js'],
      injectImmediately: true,
    });
  } catch (_) {
    // Some frames (extensions, devtools) will reject — ignore
  }
});

// Relay UPDATE_STATE from popup → active tab content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPDATE_STATE') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, msg).catch(() => {});
      }
    });
  }
  return false;
});
