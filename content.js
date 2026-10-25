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
  const AUDIO_TRACK_RETRY_MS = 250;

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
  let recaptureTimer = null;
  let deadStreamTicks = 0;
  let watchdogTimer = null;
  let lastFullRecheckAt = 0;

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
    startWatchdog();
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

    // 监听用户滚动/键盘交互，加速检测新视频
    const fastCheck = () => {
      if (!enabled) return;
      if (scanTimeout) clearTimeout(scanTimeout);
      scanTimeout = setTimeout(() => {
        scanTimeout = null;
        if (!enabled) return;
        findAndAttach();
      }, 300);
    };
    window.addEventListener('wheel', fastCheck, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') fastCheck();
    }, { passive: true });
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
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(window.innerHeight, rect.bottom);
      const visibleLeft = Math.max(0, rect.left);
      const visibleRight = Math.min(window.innerWidth, rect.right);
      const visibleArea = Math.max(0, visibleBottom - visibleTop) * Math.max(0, visibleRight - visibleLeft);

      if (visibleArea <= 0 && video.paused) continue;

      let score = visibleArea;
      if (!video.paused) score += window.innerWidth * window.innerHeight * 10;
      if (!video.muted && video.volume > 0) score *= 2;
      if (document.pictureInPictureElement === video) score *= 4;

      if (video.closest('[data-e2e="feed-active-video"]')) {
        score += window.innerWidth * window.innerHeight * 100;
      }
      
      // 彻底跳过直播间视频（直播流无法倍速，且极易导致 captureStream 音频管线卡死）
      if (video.closest('.live-player-container, [data-e2e="live-room"], .xgplayer-is-live')) {
        continue;
      }

      if (score > maxScore) {
        maxScore = score;
        best = video;
      }
    }
    return best || videos[0] || null;
  }

  // 轮询中的看门狗：事件无关地纠正“挂错视频”的情况。
  // 抖音等站点换视频可能不触发 play/Mutation 事件（元素复用或事件被吞），
  // 每 2 秒主动检查：当前真正在视口内播放的是否还是我们挂着的那个。
  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      if (!enabled) return;
      const best = findBestVideo();
      if (!best) {
        // 如果当前页面找不到普通视频（例如滑到了直播间），且旧视频已不再可见/暂停，则主动断开
        if (activeVideo && (!isVisibleVideo(activeVideo) || activeVideo.paused)) {
          log('Watchdog: no valid normal video in view, tearing down');
          teardownAudio();
          activeVideo = null;
        }
        return;
      }
      if (best === activeVideo) {
        // 挂对了元素但音频管线死了：强制重捕
        if (best.paused === false && (!analyserNode || !pollTimer) && !pendingFindTimer && !recaptureTimer) {
          log('Watchdog: pipeline dead while playing -> recapture');
          recaptureAudio(best);
        }
        return;
      }
      
      let currentOk = false;
      if (activeVideo && !activeVideo.paused) {
        const rect = activeVideo.getBoundingClientRect();
        const visibleTop = Math.max(0, rect.top);
        const visibleBottom = Math.min(window.innerHeight, rect.bottom);
        if (visibleBottom - visibleTop > window.innerHeight * 0.1) {
          currentOk = true; // 至少在视口中可见 10% 高度
        }
      }

      const bestIsActiveFeed = best.closest('[data-e2e="feed-active-video"]');
      const currentIsActiveFeed = activeVideo && activeVideo.closest('[data-e2e="feed-active-video"]');
      if (bestIsActiveFeed && !currentIsActiveFeed) {
        currentOk = false;
      }

      if (!currentOk) {
        log('Watchdog: switching video');
        attachToVideo(best, true);
      }
    }, 500); // 提速到 500ms，大幅提升切换响应速度
  }

  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  // 全量重查：重新评估整个页面正在播放的视频；若还是当前元素则强制重捕音频
  function fullRecheck(reason) {
    const best = findBestVideo();
    if (!best) return;
    log('fullRecheck:', reason);
    if (best === activeVideo) recaptureAudio(best);
    else attachToVideo(best, true);
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
    else {
      // 兜底：canplay 可能已错过（缓存视频秒开），1.5s 后若管线仍未建立则主动建立
      setTimeout(() => {
        if (activeVideo === video && enabled && !audioCtx && video.readyState >= 2) {
          log('attach fallback: setupAudio after missed canplay');
          setupAudio(video);
        }
      }, 1500);
    }
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
        diag.warning = '未检测到视频音轨，等待音频数据加载...';
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

      // 音轨被站点主动结束（换源）时，在同一元素上重新捕获
      for (const track of audioTracks) {
        track.addEventListener('ended', () => {
          if (activeVideo === video && enabled) recaptureAudio(video);
        });
      }

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

  // 复用型播放器（如抖音 reuseVideo）：切换视频不换 <video> 元素，
  // 旧的 captureStream 音轨会静默/结束。此函数在同一个元素上重新捕获音频。
  function recaptureAudio(video) {
    if (!enabled || !video || activeVideo !== video) return;
    if (recaptureTimer) clearTimeout(recaptureTimer);
    recaptureTimer = setTimeout(() => {
      recaptureTimer = null;
      if (!enabled || activeVideo !== video) return;
      log('Recapturing audio stream on same <video>');
      teardownAudio(false);
      if (video.readyState >= 2) setupAudio(video);
      else attachToVideo(video, true);
    }, 300);
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

    // 站点自身把 playbackRate 重置回 1（如抖音切换视频时），立即恢复我们的速度
    video.addEventListener('ratechange', () => {
      if (activeVideo !== video || !enabled) return;
      if (lastAppliedPlaybackRate !== null && video.playbackRate !== lastAppliedPlaybackRate && !video.paused) {
        log('External playbackRate change ->', video.playbackRate);
        applySpeed();
      }
    }, { signal });

    // 复用元素换内容（改 src / MSE 换源）时重新捕获音频流
    video.addEventListener('loadeddata', () => {
      if (activeVideo === video && enabled) recaptureAudio(video);
    }, { signal });
    video.addEventListener('durationchange', () => {
      if (activeVideo === video && enabled) recaptureAudio(video);
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
    deadStreamTicks = 0;
    lastFullRecheckAt = 0;
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
    activeVideoTime = -1;
  }

  let activeVideoTime = -1;

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

    const currentTime = activeVideo.currentTime;
    
    // 快速检测：复用元素换源时 currentTime 通常会重置到 0 附近，如果发生大幅倒退，直接重捕获
    if (activeVideoTime !== -1 && currentTime < 1.0 && activeVideoTime > currentTime + 2.0) {
      log('Video time jumped to start -> likely source changed -> recapture');
      recaptureAudio(activeVideo);
      activeVideoTime = currentTime;
      return;
    }
    activeVideoTime = currentTime;

    // 自愈：视频在播放但采样全为 0（复用元素换源后旧音轨失效），主动重捕
    if (!activeVideo.paused && rms === 0) {
      deadStreamTicks++;
      if (deadStreamTicks * POLL_INTERVAL_MS > 2000) { // 从 4 秒缩短到 2 秒，加快死流恢复
        deadStreamTicks = 0;
        log('Dead audio stream detected');
        recaptureAudio(activeVideo);
        return;
      }
    } else {
      deadStreamTicks = 0;
    }

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
      // 视频在播却持续 8 秒听不到语音：多半挂错元素或音频流已死，全量重查（限频 10 秒一次）
      if (!activeVideo.paused && silenceDuration > 8 && nowSec - lastFullRecheckAt > 10) {
        lastFullRecheckAt = nowSec;
        fullRecheck('prolonged silence while playing');
      }
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
    if (recaptureTimer) {
      clearTimeout(recaptureTimer);
      recaptureTimer = null;
    }
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
    stopWatchdog();
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
