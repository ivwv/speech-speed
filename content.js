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
  let currentSpeed = 1.0;
  let lastSpeechTime = 0;

  let activeVideo = null;
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
    stage: 'idle',
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

  // ===== Storage =====
  log('Content script loaded on %s', location.href);
  chrome.storage.local.get(['enabled', 'settings'], (data) => {
    if (data.enabled !== undefined) enabled = data.enabled;
    if (data.settings) settings = { ...DEFAULTS, ...data.settings };
    log('Stored state: enabled=%s  settings=%o', enabled, settings);
    if (enabled) init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.enabled) {
      enabled = changes.enabled.newValue;
      if (enabled) init(); else teardown();
    }
    if (changes.settings) {
      settings = { ...DEFAULTS, ...changes.settings.newValue };
    }
  });

  // ===== Message handling (popup ↔ content) =====
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'getStatus') {
      sendResponse({ enabled, currentSpeed, hasVideo: !!activeVideo, settings });
    } else if (msg.type === 'toggle') {
      enabled = !enabled;
      log('Toggled: enabled=%s', enabled);
      chrome.storage.local.set({ enabled });
      if (enabled) init(); else teardown();
      sendResponse({ enabled });
    } else if (msg.type === 'updateSettings') {
      settings = { ...DEFAULTS, ...msg.settings };
      chrome.storage.local.set({ settings });
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

  function observeDom() {
    if (domObserver) return;
    domObserver = new MutationObserver(() => {
      if (!activeVideo || !document.contains(activeVideo)) {
        teardownAudio();
        findAndAttach();
      }
    });
    domObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function findAndAttach() {
    const videos = document.querySelectorAll('video');
    log('Scanning for videos: found %d', videos.length);
    if (videos.length === 0) { diag.stage = 'waiting for <video>'; return; }

    let best = null;
    let bestArea = 0;
    videos.forEach((v) => {
      const area = v.clientWidth * v.clientHeight;
      if (area > bestArea) { best = v; bestArea = area; }
    });
    if (!best) best = videos[0];
    if (best === activeVideo && audioCtx) return;

    teardownAudio();
    activeVideo = best;
    diag.videoSrc = (activeVideo.src || activeVideo.currentSrc || '').slice(0, 80);
    log('Attaching to video (%d×%d)', activeVideo.clientWidth, activeVideo.clientHeight);

    if (activeVideo.readyState >= 2) {
      setupAudio(activeVideo);
    } else {
      diag.stage = 'waiting for canplay';
      activeVideo.addEventListener('canplay', function onCanPlay() {
        activeVideo.removeEventListener('canplay', onCanPlay);
        setupAudio(activeVideo);
      });
    }
  }

  // ===== Audio pipeline =====
  async function setupAudio(video) {
    try {
      diag.stage = 'creating AudioContext';
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      log('AudioContext: %s, %d Hz', audioCtx.state, audioCtx.sampleRate);

      diag.stage = 'capturing stream';
      let stream;
      try { stream = video.captureStream(); }
      catch { stream = video.mozCaptureStream(); }

      const audioTracks = stream.getAudioTracks();
      diag.streamTracks = audioTracks.length;
      log('MediaStream: %d audio tracks', audioTracks.length);
      if (audioTracks.length === 0) {
        log('WARNING: No audio tracks!');
        diag.stage = 'ERROR: no audio tracks';
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
      pollTimer = setInterval(() => pollAnalyser(buf), 30);

      diag.stage = 'running';
      log('Pipeline running. target=%s min=%s max=%s', settings.targetRate, settings.minSpeed, settings.maxSpeed);

      createOverlay();
      currentSpeed = video.playbackRate || 1;
      lastSpeechTime = performance.now() / 1000;
      logEntries = [];
    } catch (err) {
      diag.stage = 'ERROR: ' + err.message;
      log('FAILED: %O', err);
    }
  }

  // ===== Syllable detection =====
  function pollAnalyser(buffer) {
    if (!analyserNode) return;
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

    if (!enabled || !activeVideo) return;

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
    if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    if (activeVideo && currentSpeed !== 1) {
      try { activeVideo.playbackRate = 1; } catch {}
    }
    currentSpeed = 1;
    diag.stage = 'idle';
    diag.pollTicks = 0;
    removeOverlay();
  }

  function teardown() {
    teardownAudio();
    activeVideo = null;
    if (domObserver) { domObserver.disconnect(); domObserver = null; }
  }

  function applySpeed() {
    if (!activeVideo) return;
    const rounded = Math.round(currentSpeed * 100) / 100;
    if (activeVideo.playbackRate !== rounded) {
      activeVideo.playbackRate = rounded;
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
          background: rgba(0, 0, 0, 0.88);
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
            <div class="lbl">Speed</div>
          </div>
          <div class="ss-hero-item">
            <div class="num" id="ss-rate" style="color:#60a5fa">--</div>
            <div class="lbl">syl/s (natural)</div>
          </div>
        </div>

        <div class="ss-state" id="ss-state">--</div>
        <div class="ss-bar-wrap"><div class="ss-bar" id="ss-bar"></div></div>

        <div class="ss-log-title">History (rate → speed)</div>
        <div class="ss-log" id="ss-log"></div>

        <div class="ss-stats">
          <span id="ss-peaks">peaks: 0</span>
          <span id="ss-ticks">ticks: 0</span>
          <span id="ss-stage">idle</span>
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
      e.state.textContent = 'SPEAKING';
      e.state.className = 'ss-state speaking';
    } else {
      e.state.textContent = 'SILENCE ' + diag.silenceSec.toFixed(0) + 's';
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
      const rateStr = isSilence ? 'silence' : entry.naturalRate.toFixed(1) + ' syl/s';
      html += `<div class="${cls}">` +
        `<span class="log-rate">${rateStr}</span>` +
        `<span class="log-arrow">→</span>` +
        `<span class="log-speed">${entry.speed.toFixed(2)}x</span>` +
        `</div>`;
    }
    e.log.innerHTML = html;

    // Stats
    e.peaks.textContent = 'xings: ' + diag.lastPeakCount;
    e.ticks.textContent = 'ticks: ' + diag.pollTicks;
    e.stage.textContent = diag.stage;
  }

  function removeOverlay() {
    if (overlayHost && overlayHost.parentNode) {
      overlayHost.parentNode.removeChild(overlayHost);
    }
    overlayHost = null;
    overlayEls = {};
  }
})();
