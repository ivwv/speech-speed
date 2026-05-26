(function () {
  'use strict';

  const DEFAULTS = { targetRate: 9, minSpeed: 1.0, maxSpeed: 3.5, smoothing: 0.25, silenceHoldSec: 3 };
  const LIMITS = {
    targetRate: { min: 4, max: 14 },
    minSpeed: { min: 1, max: 5 },
    maxSpeed: { min: 1, max: 5 },
    smoothing: { min: 0.05, max: 0.8 },
    silenceHoldSec: { min: 0, max: 15 },
  };

  const toggleBtn = document.getElementById('toggle');
  const siteLine = document.getElementById('site-line');
  const statusMessage = document.getElementById('status-message');
  const errorMessage = document.getElementById('error-message');
  const curRate = document.getElementById('cur-rate');
  const curSpeed = document.getElementById('cur-speed');
  const targetSlider = document.getElementById('target-rate');
  const minSlider = document.getElementById('min-speed');
  const maxSlider = document.getElementById('max-speed');
  const targetVal = document.getElementById('target-val');
  const minVal = document.getElementById('min-val');
  const maxVal = document.getElementById('max-val');
  const resetBtn = document.getElementById('reset');
  const showOverlayCheckbox = document.getElementById('show-overlay');
  const defaultAutoEnableCheckbox = document.getElementById('default-auto-enable');
  const debugLoggingCheckbox = document.getElementById('debug-logging');

  let activeTab = null;
  let siteKey = null;
  let pollTimer = null;
  let lastStatus = null;
  let lastChangedSlider = null;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function sanitizeSettings(raw, changedKey) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const sanitized = {
      targetRate: clamp(numberOr(source.targetRate, DEFAULTS.targetRate), LIMITS.targetRate.min, LIMITS.targetRate.max),
      minSpeed: clamp(numberOr(source.minSpeed, DEFAULTS.minSpeed), LIMITS.minSpeed.min, LIMITS.minSpeed.max),
      maxSpeed: clamp(numberOr(source.maxSpeed, DEFAULTS.maxSpeed), LIMITS.maxSpeed.min, LIMITS.maxSpeed.max),
      smoothing: clamp(numberOr(source.smoothing, DEFAULTS.smoothing), LIMITS.smoothing.min, LIMITS.smoothing.max),
      silenceHoldSec: clamp(numberOr(source.silenceHoldSec, DEFAULTS.silenceHoldSec), LIMITS.silenceHoldSec.min, LIMITS.silenceHoldSec.max),
    };
    if (sanitized.minSpeed > sanitized.maxSpeed) {
      if (changedKey === 'maxSpeed') sanitized.minSpeed = sanitized.maxSpeed;
      else sanitized.maxSpeed = sanitized.minSpeed;
    }
    return sanitized;
  }

  function getSiteKey(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
    }
  }

  function getHostLabel(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname || parsed.href;
    } catch {
      return '--';
    }
  }

  function sendToTab(msg) {
    return new Promise((resolve) => {
      if (!activeTab || !activeTab.id) return resolve(null);
      chrome.tabs.sendMessage(activeTab.id, msg, (resp) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp);
      });
    });
  }

  async function init() {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      activeTab = tabs[0] || null;
      siteKey = activeTab ? getSiteKey(activeTab.url || '') : null;
      siteLine.textContent = '当前网站：' + (activeTab ? getHostLabel(activeTab.url || '') : '--');

      chrome.storage.local.get(['settings', 'showOverlay', 'defaultAutoEnable', 'autoEnable', 'debugLogging', 'sitePrefs', 'enabled'], async (data) => {
        renderSettings(sanitizeSettings(data.settings));
        showOverlayCheckbox.checked = data.showOverlay !== false;
        defaultAutoEnableCheckbox.checked = typeof data.defaultAutoEnable === 'boolean' ? data.defaultAutoEnable : data.autoEnable === true;
        debugLoggingCheckbox.checked = data.debugLogging === true;

        if (!siteKey) {
          renderUnsupported();
          return;
        }

        await migrateLegacyEnabledForSite(data);
        await pollStatus();
        pollTimer = setInterval(pollStatus, 1000);
      });
    });
  }

  function migrateLegacyEnabledForSite(data) {
    return new Promise((resolve) => {
      const sitePrefs = data.sitePrefs && typeof data.sitePrefs === 'object' ? data.sitePrefs : {};
      if (sitePrefs[siteKey] || typeof data.enabled !== 'boolean') return resolve();
      sitePrefs[siteKey] = { enabled: data.enabled, updatedAt: Date.now() };
      chrome.storage.local.set({ sitePrefs }, resolve);
    });
  }

  function renderUnsupported() {
    setControlsDisabled(true);
    toggleBtn.textContent = '不可用';
    toggleBtn.className = 'toggle off';
    statusMessage.textContent = '当前页面不支持扩展注入，请在普通网页或视频页面使用。';
    showError('');
  }

  function setControlsDisabled(disabled) {
    toggleBtn.disabled = disabled;
    targetSlider.disabled = disabled;
    minSlider.disabled = disabled;
    maxSlider.disabled = disabled;
    resetBtn.disabled = disabled;
    showOverlayCheckbox.disabled = disabled;
  }

  function showError(message) {
    if (!message) {
      errorMessage.hidden = true;
      errorMessage.textContent = '';
      return;
    }
    errorMessage.hidden = false;
    errorMessage.textContent = message;
  }

  function sourceLabel(source) {
    const labels = {
      site: '此网站设置',
      defaultAutoEnable: '所有新网站默认自动启用',
      defaultOff: '默认关闭',
      legacyAutoEnable: '旧版自动启用',
      legacyEnabled: '旧版开启状态',
      unsupported: '不支持',
    };
    return labels[source] || '默认关闭';
  }

  function renderStatus(resp) {
    lastStatus = resp;
    setControlsDisabled(false);
    toggleBtn.textContent = resp.enabled ? '此网站开启' : '此网站关闭';
    toggleBtn.className = 'toggle ' + (resp.enabled ? 'on' : 'off');
    curSpeed.textContent = Number.isFinite(resp.currentSpeed) ? resp.currentSpeed.toFixed(2) + 'x' : '1.00x';
    curRate.textContent = resp.hasVideo && resp.enabled && resp.currentRate > 0 ? resp.currentRate.toFixed(1) : '--';
    if (resp.settings) renderSettings(sanitizeSettings(resp.settings));
    showOverlayCheckbox.checked = resp.showOverlay !== false;
    debugLoggingCheckbox.checked = resp.debugLogging === true;

    let message = sourceLabel(resp.enabledSource) + ' · ' + (resp.stage || '空闲');
    if (!resp.enabled) message = '当前网站已关闭 · ' + sourceLabel(resp.enabledSource);
    else if (!resp.hasVideo) message = '已开启 · 未找到可用视频';
    else if (resp.isRunning) message = '运行中 · ' + (resp.isPlaying ? '视频播放中' : '等待播放');
    statusMessage.textContent = message;
    showError(resp.error || resp.warning || '');
  }

  function renderDisconnected() {
    if (!siteKey) {
      renderUnsupported();
      return;
    }
    setControlsDisabled(false);
    statusMessage.textContent = '无法连接当前页面，请刷新页面后重试。';
    showError('如果页面在安装或更新扩展前已打开，请刷新页面；Chrome 内部页面、扩展商店和部分受保护页面无法使用。');
  }

  function renderSettings(settings) {
    targetSlider.value = settings.targetRate;
    minSlider.value = settings.minSpeed;
    maxSlider.value = settings.maxSpeed;
    targetVal.textContent = settings.targetRate;
    minVal.textContent = settings.minSpeed.toFixed(1);
    maxVal.textContent = settings.maxSpeed.toFixed(2);
  }

  async function pollStatus() {
    if (!siteKey) return;
    const resp = await sendToTab({ type: 'getStatus' });
    if (resp) renderStatus(resp);
    else renderDisconnected();
  }

  async function persistSiteEnabled(nextEnabled) {
    const resp = await sendToTab({ type: 'setEnabled', enabled: nextEnabled });
    if (resp) {
      renderStatus(resp);
      return;
    }

    chrome.storage.local.get(['sitePrefs'], (data) => {
      const sitePrefs = data.sitePrefs && typeof data.sitePrefs === 'object' ? data.sitePrefs : {};
      sitePrefs[siteKey] = { enabled: nextEnabled, updatedAt: Date.now() };
      chrome.storage.local.set({ sitePrefs }, () => {
        toggleBtn.textContent = nextEnabled ? '此网站开启' : '此网站关闭';
        toggleBtn.className = 'toggle ' + (nextEnabled ? 'on' : 'off');
        renderDisconnected();
      });
    });
  }

  function collectSettings() {
    return {
      targetRate: parseFloat(targetSlider.value),
      minSpeed: parseFloat(minSlider.value),
      maxSpeed: parseFloat(maxSlider.value),
      smoothing: lastStatus?.settings?.smoothing ?? DEFAULTS.smoothing,
      silenceHoldSec: lastStatus?.settings?.silenceHoldSec ?? DEFAULTS.silenceHoldSec,
    };
  }

  function sendSettings() {
    const sanitized = sanitizeSettings(collectSettings(), lastChangedSlider);
    renderSettings(sanitized);
    chrome.storage.local.set({ settings: sanitized });
    sendToTab({ type: 'updateSettings', settings: sanitized });
  }

  toggleBtn.addEventListener('click', () => {
    if (!siteKey) return;
    persistSiteEnabled(!(lastStatus && lastStatus.enabled));
  });

  targetSlider.addEventListener('input', () => {
    lastChangedSlider = 'targetRate';
    sendSettings();
  });
  minSlider.addEventListener('input', () => {
    lastChangedSlider = 'minSpeed';
    sendSettings();
  });
  maxSlider.addEventListener('input', () => {
    lastChangedSlider = 'maxSpeed';
    sendSettings();
  });

  showOverlayCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ showOverlay: showOverlayCheckbox.checked });
  });

  defaultAutoEnableCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ defaultAutoEnable: defaultAutoEnableCheckbox.checked });
  });

  debugLoggingCheckbox.addEventListener('change', () => {
    chrome.storage.local.set({ debugLogging: debugLoggingCheckbox.checked });
  });

  resetBtn.addEventListener('click', () => {
    lastChangedSlider = null;
    const defaults = sanitizeSettings(DEFAULTS);
    renderSettings(defaults);
    showOverlayCheckbox.checked = true;
    defaultAutoEnableCheckbox.checked = false;
    debugLoggingCheckbox.checked = false;
    chrome.storage.local.set({
      settings: defaults,
      showOverlay: true,
      defaultAutoEnable: false,
      debugLogging: false,
    });
    sendToTab({ type: 'updateSettings', settings: defaults });
  });

  window.addEventListener('unload', () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  init();
})();
