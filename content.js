(function () {
  'use strict';

  const DEFAULTS = {
    targetRate: 9,
    minSpeed: 1.0,
    maxSpeed: 3.5,
    smoothing: 0.25,
    silenceHoldSec: 3,
  };

  const LIMITS = {
    targetRate: { min: 4, max: 14 },
    minSpeed: { min: 1, max: 5 },
    maxSpeed: { min: 1, max: 5 },
    smoothing: { min: 0.05, max: 0.8 },
    silenceHoldSec: { min: 0, max: 15 },
  };

  const POLL_INTERVAL_MS = 80;
  const OVERLAY_UPDATE_INTERVAL_MS = 250;
  const BADGE_UPDATE_INTERVAL_MS = 250;
  const DOM_SCAN_DEBOUNCE_MS = 900;
  const ATTACH_RETRY_COOLDOWN_MS = 1500;
  const AUDIO_TRACK_RETRY_MS = 1000;

  let siteKey = getSiteKey(location.href);
  let enabled = false;
  let enabledSource = 'defaultOff';
  let settings = { ...DEFAULTS };
  let overlaySettings = { showOverlay: true };
  let debugLogging = false;
  let currentSpeed = 1.0;
  let lastSpeechTime = 0;

  let activeVideo = null;
  let originalPlaybackRate = 1;
  let lastAppliedPlaybackRate = null;
  let videoAbortController = null;
  let audioCtx = null;
  let sourceNode = null;
  let highpassNode = null;
  let lowpassNode = null;
  let analyserNode = null;
  let analyserBuffer = null;
  let pollTimer = null;
  let domObserver = null;
  let scanTimeout = null;
  let pendingFindTimer = null;
  let setupGeneration = 0;
  let lastAttachAttemptVideo = null;
  let lastAttachAttemptAt = 0;

  let overlayHost = null;
  let overlayEls = {};
  let lastOverlayUpdate = 0;
  let lastBadgeText = '';
  let lastBadgeUpdate = 0;

  const detector = {
    envelope: 0,
    envelopeAlpha: 0.3,
    hpPrevInput: 0,
    hpPrevOutput: 0,
    hpAlpha: 0.9,
    prevFiltered: 0,
    crossings: [],
    lastCrossingTime: -1000,
    minCrossingInterval: 70,
    minEnergy: 0.003,
    windowSize: 4000,
    windowStart: 0,
  };

  const LOG_MAX = 12;
  let logEntries = [];
  let lastLogTime = 0;
  let logDirty = true;

  let diag = createDiag();

  function createDiag() {
    return {
      stage: '空闲',
      error: '',
      warning: '',
      videoInfo: '',
      streamTracks: 0,
      pollTicks: 0,
      lastEnergy: 0,
      lastThreshold: 0,
      lastPeakCount: 0,
      lastMeasuredRate: 0,
      lastNaturalRate: 0,
      lastTargetSpeed: 0,
      silenceSec: 0,
    };
  }

  function log(msg, ...args) {
    if (!debugLogging) return;
    console.debug('[SpeechSpeed]', msg, ...args);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function numberOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function sanitizeSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const sanitized = {
      targetRate: clamp(numberOr(source.targetRate, DEFAULTS.targetRate), LIMITS.targetRate.min, LIMITS.targetRate.max),
      minSpeed: clamp(numberOr(source.minSpeed, DEFAULTS.minSpeed), LIMITS.minSpeed.min, LIMITS.minSpeed.max),
      maxSpeed: clamp(numberOr(source.maxSpeed, DEFAULTS.maxSpeed), LIMITS.maxSpeed.min, LIMITS.maxSpeed.max),
      smoothing: clamp(numberOr(source.smoothing, DEFAULTS.smoothing), LIMITS.smoothing.min, LIMITS.smoothing.max),
      silenceHoldSec: clamp(numberOr(source.silenceHoldSec, DEFAULTS.silenceHoldSec), LIMITS.silenceHoldSec.min, LIMITS.silenceHoldSec.max),
    };
    if (sanitized.minSpeed > sanitized.maxSpeed) sanitized.maxSpeed = sanitized.minSpeed;
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

  function getEffectiveEnabled(data) {
    const prefs = data.sitePrefs && typeof data.sitePrefs === 'object' ? data.sitePrefs : {};
    if (!siteKey) return { enabled: false, source: 'unsupported' };
    if (prefs[siteKey] && typeof prefs[siteKey].enabled === 'boolean') {
      return { enabled: prefs[siteKey].enabled, source: 'site' };
    }
    if (typeof data.defaultAutoEnable === 'boolean') {
      return { enabled: data.defaultAutoEnable, source: data.defaultAutoEnable ? 'defaultAutoEnable' : 'defaultOff' };
    }
    if (typeof data.autoEnable === 'boolean') {
      return { enabled: data.autoEnable, source: data.autoEnable ? 'legacyAutoEnable' : 'defaultOff' };
    }
    return { enabled: false, source: 'defaultOff' };
  }

  function loadState() {
    chrome.storage.local.get([
      'sitePrefs',
      'defaultAutoEnable',
      'settings',
      'showOverlay',
      'debugLogging',
      'enabled',
      'autoEnable',
    ], (data) => {
      settings = sanitizeSettings(data.settings);
      overlaySettings.showOverlay = data.showOverlay !== false;
      debugLogging = data.debugLogging === true;
      const effective = getEffectiveEnabled(data);
      enabled = effective.enabled;
      enabledSource = effective.source;
      diag.stage = enabled ? '初始化' : siteKey ? '当前网站已关闭' : '当前页面不支持';
      if (enabled) init();
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.settings) {
      settings = sanitizeSettings(changes.settings.newValue);
      if (enabled && activeVideo && diag.lastNaturalRate > 0) {
        const targetSpeed = settings.targetRate / diag.lastNaturalRate;
        currentSpeed = clamp(targetSpeed, settings.minSpeed, settings.maxSpeed);
        applySpeed();
      }
    }

    if (changes.showOverlay) {
      overlaySettings.showOverlay = changes.showOverlay.newValue !== false;
      if (overlaySettings.showOverlay && activeVideo && audioCtx && !overlayHost) createOverlay();
      if (!overlaySettings.showOverlay) removeOverlay();
    }

    if (changes.debugLogging) debugLogging = changes.debugLogging.newValue === true;

    if (changes.sitePrefs || changes.defaultAutoEnable || changes.autoEnable || changes.enabled) {
      chrome.storage.local.get(['sitePrefs', 'defaultAutoEnable', 'autoEnable', 'enabled'], (data) => {
        const effective = getEffectiveEnabled(data);
        enabledSource = effective.source;
        if (effective.enabled === enabled) return;
        enabled = effective.enabled;
        if (enabled) init(); else teardown();
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (_sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: '消息来源不受信任' });
      return false;
    }

    if (msg.type === 'getStatus') {
      sendResponse(getStatus());
    } else if (msg.type === 'toggle') {
      setSiteEnabled(!enabled, sendResponse);
    } else if (msg.type === 'setEnabled') {
      setSiteEnabled(msg.enabled === true, sendResponse);
    } else if (msg.type === 'updateSettings') {
      const next = sanitizeSettings({ ...settings, ...msg.settings });
      settings = next;
      chrome.storage.local.set({ settings: next });
      sendResponse({ ok: true, settings: next });
    }
    return true;
  });

  function setSiteEnabled(nextEnabled, sendResponse) {
    if (!siteKey) {
      sendResponse({ ok: false, error: '当前页面不支持扩展注入', ...getStatus() });
      return;
    }
    chrome.storage.local.get(['sitePrefs'], (data) => {
      const sitePrefs = data.sitePrefs && typeof data.sitePrefs === 'object' ? data.sitePrefs : {};
      sitePrefs[siteKey] = { enabled: nextEnabled, updatedAt: Date.now() };
      chrome.storage.local.set({ sitePrefs }, () => {
        enabled = nextEnabled;
        enabledSource = 'site';
        if (enabled) init(); else teardown();
        sendResponse({ ok: true, ...getStatus() });
      });
    });
  }

  function getStatus() {
    return {
      ok: true,
      enabled,
      siteKey,
      enabledSource,
      currentSpeed,
      currentRate: diag.lastNaturalRate,
      hasVideo: !!activeVideo,
      isRunning: !!audioCtx && !!analyserNode && !!pollTimer,
      isPlaying: !!activeVideo && !activeVideo.paused,
      stage: diag.stage,
      error: diag.error,
      warning: diag.warning,
      settings,
      showOverlay: overlaySettings.showOverlay,
      debugLogging,
      streamTracks: diag.streamTracks,
      pollTicks: diag.pollTicks,
      lastEnergy: diag.lastEnergy,
      lastMeasuredRate: diag.lastMeasuredRate,
      lastTargetSpeed: diag.lastTargetSpeed,
      silenceSec: diag.silenceSec,
    };
  }

  function updateIconState(state) {
    try {
      chrome.runtime.sendMessage({ type: 'iconState', state });
    } catch {}
  }

  function updateBadge(speed) {
    const now = performance.now();
    const text = Number.isFinite(speed) ? speed.toFixed(1) + 'x' : '';
    if (text === lastBadgeText && now - lastBadgeUpdate < BADGE_UPDATE_INTERVAL_MS) return;
    lastBadgeText = text;
    lastBadgeUpdate = now;
    try {
      chrome.runtime.sendMessage({ type: 'updateBadge', speed });
    } catch {}
  }

  function clearBadge(state = 'idle') {
    lastBadgeText = '';
    try {
      chrome.runtime.sendMessage({ type: 'iconState', state });
    } catch {}
  }

  function init() {
    if (!siteKey) {
      enabled = false;
      diag.stage = '当前页面不支持';
      diag.error = '当前页面不支持扩展注入';
      clearBadge('disabled');
      return;
    }
    diag.error = '';
    diag.warning = '';
    findAndAttach();
    observeDom();
  }

  function setupGlobalListeners() {
    document.addEventListener('play', (e) => {
      if (!enabled || !e.target || e.target.tagName !== 'VIDEO') return;
      if (e.target !== activeVideo) {
        attachToVideo(e.target, true);
      } else if (!audioCtx && !analyserNode) {
        setupAudio(e.target);
      }
    }, true);
  }

  function isVisibleVideo(video) {
    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(video);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0;
  }

  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    let best = null;
    let maxScore = -1;
    for (const video of videos) {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area <= 0) continue;

      const visible = isVisibleVideo(video);
      if (!visible && video.paused) continue;

      let score = area;
      if (!video.paused) score *= 1000;
      if (visible) score *= 3;
      if (!video.muted && video.volume > 0) score *= 2;
      if (document.pictureInPictureElement === video) score *= 4;

      if (score > maxScore) {
        maxScore = score;
        best = video;
      }
    }
    return best || videos[0] || null;
  }

  function mutationTouchesVideo(mutations) {
    return mutations.some((mutation) => {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.tagName === 'VIDEO' || node.querySelector?.('video')) return true;
      }
      for (const node of mutation.removedNodes) {
        if (node === activeVideo || node.contains?.(activeVideo)) return true;
      }
      return false;
    });
  }

  function observeDom() {
    if (domObserver || !enabled) return;
    domObserver = new MutationObserver((mutations) => {
      if (!enabled || !mutationTouchesVideo(mutations) || scanTimeout) return;
      scanTimeout = setTimeout(() => {
        scanTimeout = null;
        if (!enabled) return;
        findAndAttach();
      }, DOM_SCAN_DEBOUNCE_MS);
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function findAndAttach() {
    if (!enabled) return;
    const best = findBestVideo();
    if (!best) {
      if (activeVideo) {
        teardownAudio();
        activeVideo = null;
      }
      diag.stage = '等待 <video>';
      diag.warning = '当前页面未找到可用视频';
      clearBadge('waiting');
      return;
    }
    diag.warning = '';
    attachToVideo(best, false);
  }

  function attachToVideo(video, force) {
    if (!enabled || !video) return;
    const now = performance.now();
    if (!force && video === lastAttachAttemptVideo && now - lastAttachAttemptAt < ATTACH_RETRY_COOLDOWN_MS) return;
    lastAttachAttemptVideo = video;
    lastAttachAttemptAt = now;

    if (activeVideo === video && audioCtx) return;
    teardownAudio();
    activeVideo = video;
    originalPlaybackRate = video.playbackRate || 1;
    lastAppliedPlaybackRate = null;
    diag.videoInfo = `${video.clientWidth}×${video.clientHeight} readyState=${video.readyState}`;
    diag.stage = video.readyState >= 2 ? '准备音频' : '等待播放';
    diag.error = '';
    updateIconState('video');

    const controller = new AbortController();
    videoAbortController = controller;
    const signal = controller.signal;

    const onCanPlay = () => {
      if (activeVideo === video && enabled) setupAudio(video);
    };
    video.addEventListener('canplay', onCanPlay, { signal, once: true });

    if (video.readyState >= 2) setupAudio(video);
  }

  async function setupAudio(video) {
    const generation = ++setupGeneration;
    stopPolling();
    try {
      diag.stage = '捕获流';
      const capture = video.captureStream || video.mozCaptureStream;
      if (typeof capture !== 'function') throw new Error('当前浏览器不支持视频音频捕获');
      const stream = capture.call(video);
      if (!isSetupCurrent(generation, video)) return;

      const audioTracks = stream.getAudioTracks();
      diag.streamTracks = audioTracks.length;
      if (audioTracks.length === 0) {
        diag.warning = '未检测到视频音轨，请确认视频未静音并已开始播放；部分受保护视频可能无法分析';
        diag.stage = '等待音频轨道';
        scheduleSetupAudioRetry(video, generation);
        updateOverlay(true);
        clearBadge('waiting');
        return;
      }
      diag.warning = '';

      diag.stage = '创建 AudioContext';
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (!isSetupCurrent(generation, video)) return;

      sourceNode = audioCtx.createMediaStreamSource(stream);
      highpassNode = audioCtx.createBiquadFilter();
      highpassNode.type = 'highpass';
      highpassNode.frequency.value = 300;
      highpassNode.Q.value = 0.7;

      lowpassNode = audioCtx.createBiquadFilter();
      lowpassNode.type = 'lowpass';
      lowpassNode.frequency.value = 3000;
      lowpassNode.Q.value = 0.7;

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0;

      sourceNode.connect(highpassNode);
      highpassNode.connect(lowpassNode);
      lowpassNode.connect(analyserNode);

      resetDetector();
      analyserBuffer = new Float32Array(analyserNode.fftSize);
      setupVideoListeners(video);

      diag.stage = audioTracks.length === 0 ? '错误：无音频轨道' : '运行中';
      currentSpeed = video.playbackRate || 1;
      lastSpeechTime = performance.now() / 1000;
      logEntries = [];
      logDirty = true;
      if (overlaySettings.showOverlay) createOverlay();
      if (!video.paused) startPolling();
      updateOverlay(true);
      log('Pipeline ready');
    } catch (err) {
      const detail = err && err.message ? err.message : '音频捕获失败';
      teardownAudio(false);
      diag.stage = '错误：音频捕获失败';
      diag.error = detail + '。请确认视频未静音、页面已开始播放；DRM/受保护视频可能无法分析。';
      clearBadge('error');
      log('Setup failed', diag.error);
    }
  }

  function isSetupCurrent(generation, video) {
    return generation === setupGeneration && activeVideo === video && enabled;
  }

  function scheduleSetupAudioRetry(video, generation) {
    if (pendingFindTimer) clearTimeout(pendingFindTimer);
    pendingFindTimer = setTimeout(() => {
      pendingFindTimer = null;
      if (isSetupCurrent(generation, video) && !video.paused) setupAudio(video);
    }, AUDIO_TRACK_RETRY_MS);
  }

  function setupVideoListeners(video) {
    if (videoAbortController) videoAbortController.abort();
    const controller = new AbortController();
    videoAbortController = controller;
    const signal = controller.signal;

    video.addEventListener('pause', stopPolling, { signal });
    video.addEventListener('ended', stopPolling, { signal });
    video.addEventListener('play', () => {
      if (activeVideo === video && enabled) startPolling();
    }, { signal });
    video.addEventListener('emptied', () => {
      teardownAudio();
      activeVideo = null;
      scheduleFindAndAttach();
    }, { signal });
  }

  function scheduleFindAndAttach() {
    if (pendingFindTimer) clearTimeout(pendingFindTimer);
    pendingFindTimer = setTimeout(() => {
      pendingFindTimer = null;
      findAndAttach();
    }, 500);
  }

  function resetDetector() {
    detector.envelope = 0;
    detector.hpPrevInput = 0;
    detector.hpPrevOutput = 0;
    detector.prevFiltered = 0;
    detector.crossings = [];
    detector.lastCrossingTime = -1000;
    detector.windowStart = performance.now();
    diag.pollTicks = 0;
    diag.lastEnergy = 0;
    diag.lastThreshold = 0;
    diag.lastPeakCount = 0;
    diag.lastMeasuredRate = 0;
    diag.lastNaturalRate = 0;
    diag.lastTargetSpeed = 0;
    diag.silenceSec = 0;
  }

  function startPolling() {
    if (pollTimer || !enabled || !activeVideo || !analyserNode || !analyserBuffer) return;
    pollTimer = setInterval(() => pollAnalyser(analyserBuffer), POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollAnalyser(buffer) {
    if (!analyserNode || !audioCtx || !enabled || !activeVideo) return;
    analyserNode.getFloatTimeDomainData(buffer);
    diag.pollTicks++;
    const now = performance.now();

    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);

    detector.envelope += detector.envelopeAlpha * (rms - detector.envelope);
    const filtered = detector.hpAlpha * (detector.hpPrevOutput + rms - detector.hpPrevInput);
    detector.hpPrevInput = rms;
    detector.hpPrevOutput = filtered;

    if (filtered > 0 && detector.prevFiltered <= 0 && detector.envelope > detector.minEnergy && now - detector.lastCrossingTime >= detector.minCrossingInterval) {
      detector.crossings.push(now);
      detector.lastCrossingTime = now;
    }
    detector.prevFiltered = filtered;

    const cutoff = now - detector.windowSize;
    detector.crossings = detector.crossings.filter((t) => t >= cutoff);
    const elapsed = Math.min(now - detector.windowStart, detector.windowSize) / 1000;
    const syllableRate = elapsed > 0.5 ? detector.crossings.length / elapsed : 0;

    diag.lastEnergy = detector.envelope;
    diag.lastThreshold = filtered;
    diag.lastPeakCount = detector.crossings.length;
    diag.lastMeasuredRate = syllableRate;

    const nowSec = now / 1000;
    if (syllableRate < 0.5 || detector.envelope < 0.002) {
      const silenceDuration = nowSec - lastSpeechTime;
      diag.silenceSec = silenceDuration;
      diag.lastNaturalRate = 0;
      diag.lastTargetSpeed = currentSpeed;
      if (silenceDuration > settings.silenceHoldSec) {
        currentSpeed += 0.03 * (1 - currentSpeed);
        applySpeed();
      }
      addLogEntry(now, 0, currentSpeed, 'silence');
      updateOverlay();
      return;
    }

    lastSpeechTime = nowSec;
    diag.silenceSec = 0;

    const naturalRate = syllableRate / Math.max(currentSpeed, 0.1);
    diag.lastNaturalRate = naturalRate;

    const targetSpeed = settings.targetRate / naturalRate;
    const clamped = clamp(targetSpeed, settings.minSpeed, settings.maxSpeed);
    diag.lastTargetSpeed = clamped;
    currentSpeed += settings.smoothing * (clamped - currentSpeed);

    applySpeed();
    addLogEntry(now, naturalRate, currentSpeed, 'speech');
    updateOverlay();
  }

  function addLogEntry(now, naturalRate, speed, state) {
    if (now - lastLogTime < 1000) return;
    lastLogTime = now;
    logEntries.push({ naturalRate, speed, state });
    if (logEntries.length > LOG_MAX) logEntries.shift();
    logDirty = true;
  }

  function applySpeed() {
    if (!activeVideo) return;
    const rounded = Math.round(currentSpeed * 100) / 100;
    if (!Number.isFinite(rounded)) return;
    if (activeVideo.playbackRate !== rounded) {
      activeVideo.playbackRate = rounded;
      lastAppliedPlaybackRate = rounded;
      updateBadge(rounded);
    }
  }

  function teardownAudio(restoreRate = true) {
    setupGeneration++;
    stopPolling();
    if (pendingFindTimer) {
      clearTimeout(pendingFindTimer);
      pendingFindTimer = null;
    }
    if (videoAbortController) {
      videoAbortController.abort();
      videoAbortController = null;
    }
    closeAudioContext();
    if (restoreRate && activeVideo && lastAppliedPlaybackRate !== null && activeVideo.playbackRate === lastAppliedPlaybackRate) {
      try { activeVideo.playbackRate = originalPlaybackRate; } catch {}
    }
    currentSpeed = activeVideo ? activeVideo.playbackRate || 1 : 1;
    lastAppliedPlaybackRate = null;
    resetDetector();
    diag.stage = enabled ? '空闲' : '当前网站已关闭';
    removeOverlay();
    clearBadge(enabled ? 'idle' : 'disabled');
  }

  function closeAudioContext() {
    if (analyserNode) { try { analyserNode.disconnect(); } catch {} analyserNode = null; }
    if (lowpassNode) { try { lowpassNode.disconnect(); } catch {} lowpassNode = null; }
    if (highpassNode) { try { highpassNode.disconnect(); } catch {} highpassNode = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    analyserBuffer = null;
  }

  function teardown() {
    teardownAudio();
    activeVideo = null;
    if (scanTimeout) {
      clearTimeout(scanTimeout);
      scanTimeout = null;
    }
    if (domObserver) {
      domObserver.disconnect();
      domObserver = null;
    }
    logEntries = [];
    lastLogTime = 0;
    logDirty = true;
    diag = createDiag();
    diag.stage = siteKey ? '当前网站已关闭' : '当前页面不支持';
  }

  function createOverlay() {
    if (overlayHost) return;
    overlayHost = document.createElement('div');
    overlayHost.id = 'speech-speed-host';
    const shadow = overlayHost.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .ss { position: fixed; top: 10px; right: 10px; z-index: 2147483647; background: rgba(0, 0, 0, 0.25); color: #fff; font: 12px/1.4 'SF Mono', 'Menlo', 'Consolas', monospace; padding: 10px 14px; border-radius: 10px; pointer-events: none; user-select: none; min-width: 220px; }
        .ss-hero { display: flex; justify-content: space-around; text-align: center; margin-bottom: 6px; }
        .num { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.1; }
        .lbl { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
        .speed-color { color: #4ade80; }
        .rate-color { color: #60a5fa; }
        .ss-state { text-align: center; font-size: 11px; font-weight: 600; padding: 2px 0 6px; }
        .speaking { color: #4ade80; }
        .silence  { color: #f59e0b; }
        .ss-log { font-size: 11px; line-height: 1.5; max-height: 120px; overflow: hidden; }
        .ss-log-row { display: flex; gap: 6px; opacity: 0.5; }
        .ss-log-row:last-child { opacity: 1; font-weight: 600; }
        .log-rate { color: #60a5fa; min-width: 70px; }
        .log-arrow { color: #555; }
        .log-speed { color: #4ade80; min-width: 50px; }
        .log-silence .log-rate, .log-silence .log-speed { color: #f59e0b; }
        .ss-stats { display: flex; justify-content: space-between; font-size: 10px; color: #777; margin-top: 6px; padding-top: 4px; border-top: 1px solid #222; }
      </style>
      <div class="ss">
        <div class="ss-hero">
          <div><div class="num speed-color" id="ss-speed">1.00x</div><div class="lbl">当前倍速</div></div>
          <div><div class="num rate-color" id="ss-rate">--</div><div class="lbl">原速</div></div>
        </div>
        <div class="ss-state" id="ss-state">--</div>
        <div class="ss-log" id="ss-log"></div>
        <div class="ss-stats"><span id="ss-peaks">音节: 0</span><span id="ss-stage">空闲</span></div>
      </div>
    `;
    overlayEls = {
      speed: shadow.getElementById('ss-speed'),
      rate: shadow.getElementById('ss-rate'),
      state: shadow.getElementById('ss-state'),
      log: shadow.getElementById('ss-log'),
      peaks: shadow.getElementById('ss-peaks'),
      stage: shadow.getElementById('ss-stage'),
    };
    document.documentElement.appendChild(overlayHost);
    lastOverlayUpdate = 0;
    updateOverlay(true);
  }

  function updateOverlay(force = false) {
    if (!overlayEls.speed) return;
    const now = performance.now();
    if (!force && now - lastOverlayUpdate < OVERLAY_UPDATE_INTERVAL_MS) return;
    lastOverlayUpdate = now;

    overlayEls.speed.textContent = currentSpeed.toFixed(2) + 'x';
    const nr = diag.lastNaturalRate;
    overlayEls.rate.textContent = nr > 0 ? nr.toFixed(1) : '--';
    if (nr > 0) {
      overlayEls.state.textContent = '正在说话';
      overlayEls.state.className = 'ss-state speaking';
    } else {
      overlayEls.state.textContent = '静音 ' + diag.silenceSec.toFixed(0) + '秒';
      overlayEls.state.className = 'ss-state silence';
    }
    if (logDirty) renderLog();
    overlayEls.peaks.textContent = '音节: ' + diag.lastPeakCount;
    overlayEls.stage.textContent = diag.stage;
  }

  function renderLog() {
    if (!overlayEls.log) return;
    overlayEls.log.textContent = '';
    const fragment = document.createDocumentFragment();
    for (const entry of logEntries) {
      const row = document.createElement('div');
      row.className = entry.state === 'silence' ? 'ss-log-row log-silence' : 'ss-log-row';
      const rate = document.createElement('span');
      rate.className = 'log-rate';
      rate.textContent = entry.state === 'silence' ? '静音' : entry.naturalRate.toFixed(1) + ' 音节/秒';
      const arrow = document.createElement('span');
      arrow.className = 'log-arrow';
      arrow.textContent = '→';
      const speed = document.createElement('span');
      speed.className = 'log-speed';
      speed.textContent = entry.speed.toFixed(2) + 'x';
      row.append(rate, arrow, speed);
      fragment.appendChild(row);
    }
    overlayEls.log.appendChild(fragment);
    logDirty = false;
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) overlayHost.parentNode.removeChild(overlayHost);
    overlayHost = null;
    overlayEls = {};
  }

  setupGlobalListeners();
  loadState();
})();
