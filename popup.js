(function () {
  'use strict';

  const DEFAULTS = { targetRate: 9, minSpeed: 1.0, maxSpeed: 3.5 };

  const toggleBtn = document.getElementById('toggle');
  const curRate   = document.getElementById('cur-rate');
  const curSpeed  = document.getElementById('cur-speed');
  const targetSlider = document.getElementById('target-rate');
  const minSlider    = document.getElementById('min-speed');
  const maxSlider    = document.getElementById('max-speed');
  const targetVal = document.getElementById('target-val');
  const minVal    = document.getElementById('min-val');
  const maxVal    = document.getElementById('max-val');
  const resetBtn  = document.getElementById('reset');
  const showOverlayCheckbox = document.getElementById('show-overlay');
  const autoEnableCheckbox = document.getElementById('auto-enable');

  // --- Communicate with content script ---
  function sendToTab(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return resolve(null);
        chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp);
        });
      });
    });
  }

  // --- Toggle ---
  toggleBtn.addEventListener('click', async () => {
    const resp = await sendToTab({ type: 'toggle' });
    if (resp) updateToggle(resp.enabled);
  });

  function updateToggle(on) {
    toggleBtn.textContent = on ? 'ON' : 'OFF';
    toggleBtn.className = 'toggle ' + (on ? 'on' : 'off');
  }

  // --- Sliders ---
  function sendSettings() {
    const s = {
      targetRate: parseFloat(targetSlider.value),
      minSpeed:   parseFloat(minSlider.value),
      maxSpeed:   parseFloat(maxSlider.value),
    };
    targetVal.textContent = s.targetRate;
    minVal.textContent    = s.minSpeed.toFixed(1);
    maxVal.textContent    = s.maxSpeed.toFixed(2);
    sendToTab({ type: 'updateSettings', settings: s });
  }

  targetSlider.addEventListener('input', sendSettings);
  minSlider.addEventListener('input', sendSettings);
  maxSlider.addEventListener('input', sendSettings);

  // --- Settings checkboxes ---
  function loadSettings() {
    chrome.storage.local.get(['showOverlay', 'autoEnable'], (data) => {
      showOverlayCheckbox.checked = data.showOverlay !== false;
      autoEnableCheckbox.checked = data.autoEnable === true;
    });
  }

  showOverlayCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ showOverlay: showOverlayCheckbox.checked });
    sendToTab({ type: 'updateSettings', settings: { showOverlay: showOverlayCheckbox.checked } });
  });

  autoEnableCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ autoEnable: autoEnableCheckbox.checked });
  });

  // --- Reset ---
  resetBtn.addEventListener('click', () => {
    targetSlider.value = DEFAULTS.targetRate;
    minSlider.value    = DEFAULTS.minSpeed;
    maxSlider.value    = DEFAULTS.maxSpeed;
    sendSettings();
  });

  // --- Poll status ---
  let pollTimer = null;

  async function pollStatus() {
    const resp = await sendToTab({ type: 'getStatus' });
    if (resp) {
      updateToggle(resp.enabled);
      curSpeed.textContent = resp.currentSpeed.toFixed(2) + 'x';
      if (resp.settings) {
        targetSlider.value = resp.settings.targetRate;
        minSlider.value    = resp.settings.minSpeed;
        maxSlider.value    = resp.settings.maxSpeed;
        targetVal.textContent = resp.settings.targetRate;
        minVal.textContent    = resp.settings.minSpeed.toFixed(1);
        maxVal.textContent    = resp.settings.maxSpeed.toFixed(2);
      }
    }
  }

  loadSettings();
  pollStatus();
  pollTimer = setInterval(async () => {
    const resp = await sendToTab({ type: 'getStatus' });
    if (resp) {
      curSpeed.textContent = resp.currentSpeed.toFixed(2) + 'x';
    }
  }, 500);

  window.addEventListener('unload', () => clearInterval(pollTimer));
})();
