(function () {
  'use strict';

  // ===== Default settings =====
  const DEFAULTS = {
    targetRate: 9,      // desired syllable rate (syl/s) heard by user
    minSpeed: 1.0,
    maxSpeed: 3.5,
    smoothing: 0.25,    // EMA alpha — faster for more obvious transitions
    silenceHoldSec: 3,  // seconds of silence before ramping toward 1×
  };

  // ===== State =====
  let enabled = false;
  let settings = { ...DEFAULTS };
  let overlaySettings = { showOverlay: true, autoEnable: false };
  let currentSpeed = 1.0;
  let lastSpeechTime = 0;

  let activeVideo = null;
  let videoRemovalObserver = null;
  let audioCtx = null;
  let sourceNode = null;
  let analyserNode = null;
  let pollTimer = null;
  let overlayHost = null;
  let overlayEls = {};       // all overlay DOM refs

  // Syllable detector: energy-envelope modulation via high-pass + zero-crossing.
  // Old approach (threshold peak-counting) undercounted fast speech because
  // energy stayed above threshold continuously. This approach isolates the
  // syllable-rate modulation by high-passing the energy envelope, then counts
  // positive-going zero-crossings of the filtered signal.
  const detector = {
    // Smoothed envelope (for silence gating & display)
    envelope: 0,
    envelopeAlpha: 0.3,

    // High-pass filter state: removes DC/slow drift from energy,
    // leaving only syllable-rate modulation (2-10 Hz)
    hpPrevInput: 0,
    hpPrevOutput: 0,
    hpAlpha: 0.9,           // cutoff ~0.5 Hz at 33 Hz polling

    // Zero-crossing detection on high-passed energy
    prevFiltered: 0,
    crossings: [],           // timestamps of positive-going zero crossings
    lastCrossingTime: -1000,
    minCrossingInterval: 70, // ms — caps at ~14 syl/s

    // Silence gate
    minEnergy: 0.003,

    // Window for rate computation
    windowSize: 4000,        // ms
  };

  // Scrolling log buffer (last N entries)
  const LOG_MAX = 12;
  let logEntries = [];       // { time, naturalRate, speed, state }
  let lastLogTime = 0;

  // Diagnostics
  let diag = {
    stage: '空闲',
    videoSrc: '',
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

  function log(msg, ...args) {
    console.log(`%c[SpeechSpeed]%c ${msg}`, 'color:#4ade80;font-weight:bold', 'color:inherit', ...args);
  }

  function updateIconState(state) {
    try {
      chrome.runtime.sendMessage({ type: 'iconState', state: state });
    } catch (e) {
      // Ignore errors when background isn't available
    }
  }

  // ===== Storage =====
  log('Content script loaded on %s', location.href);
  chrome.storage.local.get(['enabled', 'settings', 'showOverlay', 'autoEnable'], (data) => {
    if (data.enabled !== undefined) enabled = data.enabled;
    if (data.settings) settings = { ...DEFAULTS, ...data.settings };
    overlaySettings.showOverlay = data.showOverlay !== false;
    overlaySettings.autoEnable = data.autoEnable === true;
    if (overlaySettings.autoEnable && !enabled) {
      enabled = true;
      chrome.storage.local.set({ enabled: true });
    }
    log('Stored state: enabled=%s  settings=%o  showOverlay=%s  autoEnable=%s', enabled, settings, overlaySettings.showOverlay, overlaySettings.autoEnable);
    if (enabled) init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) init(); else teardown();
    }
    if (changes.settings) {
      settings = { ...DEFAULTS, ...changes.settings.newValue };
      // Apply new speed immediately if speech is happening
      if (enabled && activeVideo && diag.lastNaturalRate > 0) {
        const targetSpeed = settings.targetRate / diag.lastNaturalRate;
        const clamped = Math.max(settings.minSpeed, Math.min(settings.maxSpeed, targetSpeed));
        currentSpeed = clamped;
        applySpeed();
      }
    }
    if (changes.showOverlay !== undefined) {
      overlaySettings.showOverlay = changes.showOverlay.newValue;
      if (overlaySettings.showOverlay) {
        if (activeVideo && audioCtx && !overlayHost) {
          createOverlay();
        }
      } else {
        removeOverlay();
      }
    }
    if (changes.autoEnable !== undefined) {
      overlaySettings.autoEnable = changes.autoEnable.newValue;
    }
  });

  // ===== Message handling (popup ↔ content) =====
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({ enabled, currentSpeed, currentRate: diag.lastNaturalRate, hasVideo: !!activeVideo, settings });
    } else if (msg.type === 'toggle') {
      enabled = !enabled;
      log('Toggled: enabled=%s', enabled);
      chrome.storage.local.set({ enabled });
      if (enabled) init(); else teardown();
      sendResponse({ enabled });
    } else if (msg.type === 'updateSettings') {
      const { showOverlay, ...rest } = msg.settings;
      if (showOverlay !== undefined) {
        overlaySettings.showOverlay = showOverlay;
      }
      if (Object.keys(rest).length > 0) {
        // Merge into current settings instead of defaults
        settings = { ...settings, ...rest };
        chrome.storage.local.set({ settings });
      }
      sendResponse({ ok: true });
    }
    return true;
  });

  // ===== Initialization =====
  function init() {
    findAndAttach();
    observeDom();
  }

  let domObserver = null;

  function setupGlobalListeners() {
    // Catch when a video starts playing - very reliable for dynamic feeds like Douyin
    document.addEventListener('play', (e) => {
      if (!enabled) return;
      if (e.target.tagName === 'VIDEO' && e.target !== activeVideo) {
        log('Switching to playing video');
        attachToVideo(e.target);
      }
    }, true);
  }

  function findBestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;

    // Score videos based on: playing state > visibility > area
    let best = null;
    let maxScore = -1;

    videos.forEach(v => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area === 0) return;

      const isVisible = (
        rect.top < (window.innerHeight || document.documentElement.clientHeight) &&
        rect.bottom > 0 &&
        rect.left < (window.innerWidth || document.documentElement.clientWidth) &&
        rect.right > 0
      );

      let score = area;
      if (!v.paused) score *= 1000; // Strongly prefer playing videos
      if (isVisible) score *= 2;    // Prefer visible ones

      if (score > maxScore) {
        maxScore = score;
        best = v;
      }
    });

    return best || videos[0];
  }

  function observeDom() {
    if (domObserver) return;
    let checkTimeout = null;
    domObserver = new MutationObserver(() => {
      if (checkTimeout) return;
      checkTimeout = setTimeout(() => {
        checkTimeout = null;
        if (!enabled) return;
        
        const best = findBestVideo();
        if (!best) {
          if (activeVideo) {
            teardownAudio();
            activeVideo = null;
          }
          return;
        }

        if (best !== activeVideo || !audioCtx) {
          attachToVideo(best);
        }
      }, 500); // Slightly longer debounce for performance
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function findAndAttach() {
    const best = findBestVideo();
    if (!best) {
      if (activeVideo) {
        teardownAudio();
        activeVideo = null;
      }
      diag.stage = '等待 <video>';
      return;
    }
    attachToVideo(best);
  }

  function attachToVideo(video) {
    if (activeVideo === video && audioCtx) return;

    teardownAudio();
    activeVideo = video;
    diag.videoSrc = (activeVideo.src || activeVideo.currentSrc || '').slice(0, 80);
    log('Attaching to video (%d×%d) src=%s', activeVideo.clientWidth, activeVideo.clientHeight, diag.videoSrc);
    updateIconState('video');

    if (activeVideo.readyState >= 2) {
      setupAudio(activeVideo);
    } else {
      diag.stage = '等待播放';
      const onCanPlay = function() {
        if (activeVideo === video) {
          setupAudio(activeVideo);
        }
        activeVideo.removeEventListener('canplay', onCanPlay);
      };
      activeVideo.addEventListener('canplay', onCanPlay);
    }
  }

  // ===== Audio pipeline =====
  async function setupAudio(video) {
    try {
      diag.stage = '创建 AudioContext';
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      log('AudioContext: %s, %d Hz', audioCtx.state, audioCtx.sampleRate);

      diag.stage = '捕获流';
      let stream;
      try { stream = video.captureStream(); }
      catch { stream = video.mozCaptureStream(); }

      const audioTracks = stream.getAudioTracks();
      diag.streamTracks = audioTracks.length;
      log('MediaStream: %d audio tracks', audioTracks.length);
      if (audioTracks.length === 0) {
        log('WARNING: No audio tracks!');
        diag.stage = '错误：无音频轨道';
      }

      sourceNode = audioCtx.createMediaStreamSource(stream);

      const highpass = audioCtx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 300;
      highpass.Q.value = 0.7;

      const lowpass = audioCtx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 3000;
      lowpass.Q.value = 0.7;

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0;

      sourceNode.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(analyserNode);

      detector.envelope = 0;
      detector.hpPrevInput = 0;
      detector.hpPrevOutput = 0;
      detector.prevFiltered = 0;
      detector.crossings = [];
      detector.lastCrossingTime = -1000;

      const buf = new Float32Array(analyserNode.fftSize);
       
       // Event listeners for playback state
       const onPause = () => {
         if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
       };
       const onPlay = () => {
         if (!pollTimer && activeVideo === video && enabled) {
           pollTimer = setInterval(() => pollAnalyser(buf), 30);
         }
       };
       const onEmptied = () => {
         teardownAudio();
         activeVideo = null;
         setTimeout(() => findAndAttach(), 500);
       };

       video.addEventListener('pause', onPause);
       video.addEventListener('play', onPlay);
       video.addEventListener('emptied', onEmptied);

       // Store cleanup function
       video._ssCleanup = () => {
         video.removeEventListener('pause', onPause);
         video.removeEventListener('play', onPlay);
         video.removeEventListener('emptied', onEmptied);
         if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
       };

       if (!video.paused) {
         pollTimer = setInterval(() => pollAnalyser(buf), 30);
       }

       diag.stage = '运行中';
       log('Pipeline running. target=%s min=%s max=%s', settings.targetRate, settings.minSpeed, settings.maxSpeed);
       updateIconState('speeding');

       if (overlaySettings.showOverlay) {
         createOverlay();
       }
       currentSpeed = video.playbackRate || 1;
       lastSpeechTime = performance.now() / 1000;
       logEntries = [];
    } catch (err) {
      diag.stage = '错误：' + err.message;
      log('FAILED: %O', err);
    }
  }

  // ===== Syllable detection =====
  function pollAnalyser(buffer) {
    if (!analyserNode || !audioCtx || !enabled) return;
    analyserNode.getFloatTimeDomainData(buffer);
    diag.pollTicks++;
    const now = performance.now();

    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);

    // Smooth envelope for silence gating & display
    detector.envelope += detector.envelopeAlpha * (rms - detector.envelope);

    // High-pass filter: removes DC/slow drift, isolates syllable-rate modulation
    const filtered = detector.hpAlpha * (detector.hpPrevOutput + rms - detector.hpPrevInput);
    detector.hpPrevInput = rms;
    detector.hpPrevOutput = filtered;

    // Count positive-going zero-crossings of filtered energy (each = 1 syllable)
    if (filtered > 0 && detector.prevFiltered <= 0 &&
        detector.envelope > detector.minEnergy &&
        (now - detector.lastCrossingTime) >= detector.minCrossingInterval) {
      detector.crossings.push(now);
      detector.lastCrossingTime = now;
    }
    detector.prevFiltered = filtered;

    // Compute rate over sliding window
    const cutoff = now - detector.windowSize;
    detector.crossings = detector.crossings.filter((t) => t >= cutoff);
    const elapsed = Math.min(diag.pollTicks * 30, detector.windowSize) / 1000;
    const syllableRate = elapsed > 0.5 ? detector.crossings.length / elapsed : 0;

    diag.lastEnergy = detector.envelope;
    diag.lastThreshold = filtered;  // show filtered signal for debugging
    diag.lastPeakCount = detector.crossings.length;
    diag.lastMeasuredRate = syllableRate;

    if (!enabled || !activeVideo || !audioCtx) return;

    const shouldLog = diag.pollTicks % 66 === 0;
    const nowSec = now / 1000;

    // Silence
    if (syllableRate < 0.5 || detector.envelope < 0.002) {
      const silenceDuration = nowSec - lastSpeechTime;
      diag.silenceSec = silenceDuration;
      diag.lastNaturalRate = 0;
      diag.lastTargetSpeed = currentSpeed;
      if (silenceDuration > settings.silenceHoldSec) {
        currentSpeed += 0.03 * (1 - currentSpeed);
        applySpeed();
      }
      if (shouldLog) {
        log('SILENCE  energy=%.5f  filtered=%.5f  silence=%.1fs  speed=%.2f',
            detector.envelope, filtered, silenceDuration, currentSpeed);
      }
      addLogEntry(now, 0, currentSpeed, 'silence');
      updateOverlay();
      return;
    }

    lastSpeechTime = nowSec;
    diag.silenceSec = 0;

    const naturalRate = syllableRate / currentSpeed;
    diag.lastNaturalRate = naturalRate;

    const targetSpeed = settings.targetRate / naturalRate;
    const clamped = Math.max(settings.minSpeed, Math.min(settings.maxSpeed, targetSpeed));
    diag.lastTargetSpeed = clamped;

    currentSpeed += settings.smoothing * (clamped - currentSpeed);

    if (shouldLog) {
      log('SPEECH  crossings=%d  measured=%.1f  natural=%.1f syl/s  target=%.2fx  speed=%.2fx  filtered=%.5f',
          detector.crossings.length, syllableRate, naturalRate, clamped, currentSpeed, filtered);
    }

    applySpeed();
    addLogEntry(now, naturalRate, currentSpeed, 'speech');
    updateOverlay();
  }

  function addLogEntry(now, naturalRate, speed, state) {
    // Only add once per second to keep log readable
    if (now - lastLogTime < 1000) return;
    lastLogTime = now;
    logEntries.push({ naturalRate, speed, state });
    if (logEntries.length > LOG_MAX) logEntries.shift();
  }

  function teardownAudio() {
    log('Tearing down');
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (analyserNode) { try { analyserNode.disconnect(); } catch {} analyserNode = null; }
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
    if (audioCtx) { 
      try { audioCtx.close(); } catch {} 
      audioCtx = null; 
    }
    if (activeVideo) {
      try { activeVideo.playbackRate = 1; } catch {}
      if (activeVideo._ssCleanup) {
        activeVideo._ssCleanup();
        delete activeVideo._ssCleanup;
      }
    }
    currentSpeed = 1;
    diag.stage = '空闲';
    updateIconState('idle');
    diag.pollTicks = 0;
    diag.streamTracks = 0;
    diag.lastEnergy = 0;
    diag.lastThreshold = 0;
    diag.lastPeakCount = 0;
    diag.lastMeasuredRate = 0;
    diag.lastNaturalRate = 0;
    diag.lastTargetSpeed = 0;
    diag.silenceSec = 0;
    removeOverlay();
  }

  function teardown() {
    teardownAudio();
    activeVideo = null;
    if (videoRemovalObserver) {
      videoRemovalObserver.disconnect();
      videoRemovalObserver = null;
    }
    detector.envelope = 0;
    detector.hpPrevInput = 0;
    detector.hpPrevOutput = 0;
    detector.prevFiltered = 0;
    detector.crossings = [];
    detector.lastCrossingTime = -1000;
    logEntries = [];
    lastLogTime = 0;
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  function applySpeed() {
    if (!activeVideo) return;
    const rounded = Math.round(currentSpeed * 100) / 100;
    if (activeVideo.playbackRate !== rounded) {
      activeVideo.playbackRate = rounded;
      
      // Update browser action badge
      try {
        chrome.runtime.sendMessage({ type: 'updateBadge', speed: rounded });
      } catch (e) {
        // Background might be disconnected
      }
    }
  }

  // ===== Overlay =====
  function createOverlay() {
    if (overlayHost) return;

    overlayHost = document.createElement('div');
    overlayHost.id = 'speech-speed-host';
    const shadow = overlayHost.attachShadow({ mode: 'closed' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .ss {
          position: fixed;
          top: 10px;
          right: 10px;
          z-index: 2147483647;
          background: rgba(0, 0, 0, 0.25);
          color: #fff;
          font: 12px/1.4 'SF Mono', 'Menlo', 'Consolas', monospace;
          padding: 10px 14px;
          border-radius: 10px;
          pointer-events: none;
          user-select: none;
          min-width: 260px;
        }

        /* Big hero numbers */
        .ss-hero {
          display: flex;
          justify-content: space-around;
          text-align: center;
          margin-bottom: 6px;
        }
        .ss-hero-item .num {
          font-size: 28px;
          font-weight: 700;
          font-variant-numeric: tabular-nums;
          line-height: 1.1;
        }
        .ss-hero-item .lbl {
          font-size: 10px;
          color: #888;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .speed-color { color: #4ade80; }

        /* State badge */
        .ss-state {
          text-align: center;
          font-size: 11px;
          font-weight: 600;
          padding: 2px 0 6px;
        }
        .speaking { color: #4ade80; }
        .silence  { color: #f59e0b; }

        /* Energy bar */
        .ss-bar-wrap {
          height: 3px;
          background: #333;
          border-radius: 2px;
          margin: 0 0 8px;
          overflow: hidden;
        }
        .ss-bar {
          height: 100%;
          background: #4ade80;
          border-radius: 2px;
          transition: width 0.15s;
          width: 0%;
        }

        /* Scrolling log */
        .ss-log-title {
          font-size: 10px;
          color: #666;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 3px;
        }
        .ss-log {
          font-size: 11px;
          line-height: 1.5;
          max-height: 216px;
          overflow: hidden;
        }
        .ss-log-row {
          display: flex;
          gap: 6px;
          opacity: 0.5;
        }
        .ss-log-row:last-child {
          opacity: 1;
          font-weight: 600;
        }
        .ss-log-row:nth-last-child(2) { opacity: 0.8; }
        .ss-log-row:nth-last-child(3) { opacity: 0.65; }
        .log-rate { color: #60a5fa; min-width: 70px; }
        .log-arrow { color: #555; }
        .log-speed { color: #4ade80; min-width: 50px; }
        .log-state { color: #888; font-size: 10px; }
        .log-silence .log-rate { color: #f59e0b; }
        .log-silence .log-speed { color: #f59e0b; }

        /* Small stats row */
        .ss-stats {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #555;
          margin-top: 6px;
          padding-top: 4px;
          border-top: 1px solid #222;
        }
      </style>
      <div class="ss">
        <div class="ss-hero">
          <div class="ss-hero-item">
            <div class="num speed-color" id="ss-speed">1.00x</div>
            <div class="lbl">当前倍速</div>
          </div>
          <div class="ss-hero-item">
            <div class="num" id="ss-rate" style="color:#60a5fa">--</div>
            <div class="lbl">原速 (音节/秒)</div>
          </div>
        </div>

        <div class="ss-state" id="ss-state">--</div>
        <div class="ss-bar-wrap"><div class="ss-bar" id="ss-bar"></div></div>

        <div class="ss-log-title">历史记录 (语速 → 倍速)</div>
        <div class="ss-log" id="ss-log"></div>

        <div class="ss-stats">
          <span id="ss-peaks">音节: 0</span>
          <span id="ss-ticks">采样: 0</span>
          <span id="ss-stage">空闲</span>
        </div>
      </div>
    `;

    overlayEls = {
      speed: shadow.getElementById('ss-speed'),
      rate:  shadow.getElementById('ss-rate'),
      state: shadow.getElementById('ss-state'),
      bar:   shadow.getElementById('ss-bar'),
      log:   shadow.getElementById('ss-log'),
      peaks: shadow.getElementById('ss-peaks'),
      ticks: shadow.getElementById('ss-ticks'),
      stage: shadow.getElementById('ss-stage'),
    };
    document.documentElement.appendChild(overlayHost);
  }

  function updateOverlay() {
    const e = overlayEls;
    if (!e.speed) return;

    // Hero numbers
    e.speed.textContent = currentSpeed.toFixed(2) + 'x';
    const nr = diag.lastNaturalRate;
    e.rate.textContent = nr > 0 ? nr.toFixed(1) : '--';

    // State
    if (nr > 0) {
      e.state.textContent = '正在说话';
      e.state.className = 'ss-state speaking';
    } else {
      e.state.textContent = '静音 ' + diag.silenceSec.toFixed(0) + '秒';
      e.state.className = 'ss-state silence';
    }

    // Energy bar
    const barPct = Math.min(100, Math.max(0, (Math.log10(diag.lastEnergy + 1e-6) + 5) * 25));
    e.bar.style.width = barPct + '%';

    // Scrolling log
    let html = '';
    for (const entry of logEntries) {
      const isSilence = entry.state === 'silence';
      const cls = isSilence ? 'ss-log-row log-silence' : 'ss-log-row';
      const rateStr = isSilence ? '静音' : entry.naturalRate.toFixed(1) + ' 音节/秒';
      html += `<div class="${cls}">` +
        `<span class="log-rate">${rateStr}</span>` +
        `<span class="log-arrow">→</span>` +
        `<span class="log-speed">${entry.speed.toFixed(2)}x</span>` +
        `</div>`;
    }
    e.log.innerHTML = html;

    // Stats
    e.peaks.textContent = '音节: ' + diag.lastPeakCount;
    e.ticks.textContent = '采样: ' + diag.pollTicks;
    e.stage.textContent = diag.stage;
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) {
      overlayHost.parentNode.removeChild(overlayHost);
    }
    overlayHost = null;
    overlayEls = {};
  }

  // ===== One-time global setup =====
  setupGlobalListeners();
})();
