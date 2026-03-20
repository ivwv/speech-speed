(function () {
  'use strict';

  const ICON_COLORS = {
    idle: '#9ca3af',
    video: '#3b82f6',
    speeding: '#22c55e',
  };

  function createSvgIcon(color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <circle cx="16" cy="16" r="14" fill="${color}" opacity="0.2"/>
  <circle cx="16" cy="16" r="14" fill="none" stroke="${color}" stroke-width="2"/>
  <path d="M10 14 L10 18 L13 18 L13 14 Z M14 12 L14 20 L17 20 L17 12 Z M18 10 L18 22 L21 22 L21 10 Z M22 13 L22 19 L25 19 L25 13 Z" fill="${color}"/>
  <path d="M8 22 Q16 26 24 22" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function updateIcon(state) {
    const color = ICON_COLORS[state] || ICON_COLORS.idle;
    const icon = { icon32: createSvgIcon(color) };
    try {
      chrome.action.setIcon(icon, () => {
        if (chrome.runtime.lastError) {
          console.warn('[SpeechSpeed BG] setIcon error:', chrome.runtime.lastError.message);
        }
      });
    } catch (e) {
      console.warn('[SpeechSpeed BG] setIcon exception:', e);
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'iconState') {
      updateIcon(msg.state);
      sendResponse({ ok: true });
    }
    return true;
  });

  chrome.runtime.onInstalled.addListener(() => {
    updateIcon('idle');
  });

  updateIcon('idle');
})();
