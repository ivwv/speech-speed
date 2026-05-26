# Speech Speed

A Chrome extension that dynamically adjusts video playback speed based on how fast the speaker is talking. Slow speakers get sped up more; fast speakers get sped up less. The goal is to normalize speech to a comfortable listening rate so you can consume video content faster without rapid passages becoming unintelligible.

## How it works

### Audio capture

When enabled for the current site, the content script finds the best visible `<video>` element and taps its audio output with `HTMLMediaElement.captureStream()`. The stream is analyzed through Web Audio:

```text
video.captureStream()
  → MediaStreamSource
    → BiquadFilter (highpass 300 Hz)
      → BiquadFilter (lowpass 3000 Hz)
        → AnalyserNode
```

The 300-3000 Hz bandpass focuses on the vowel/formant region where syllable energy is concentrated.

### Syllable rate detection

The current detector measures modulation in the audio energy envelope:

1. Compute RMS energy from the analyser buffer.
2. Smooth the envelope for silence detection.
3. High-pass the raw RMS signal to remove slow level drift.
4. Count positive-going zero-crossings in the filtered energy signal.
5. Estimate syllables per second over a sliding time window.

This avoids the undercounting that simple threshold peak detection can produce during fast continuous speech.

### Speed mapping

The detected rate is converted into playback speed:

```js
naturalRate = measuredRate / currentPlaybackSpeed
targetSpeed = targetSyllableRate / naturalRate
targetSpeed = clamp(targetSpeed, minSpeed, maxSpeed)
currentSpeed += smoothingAlpha * (targetSpeed - currentSpeed)
```

The `measuredRate / currentPlaybackSpeed` correction matters because captured audio reflects the current playback speed. If the video is already playing at 2x, the measured syllable rate is also doubled.

During silence, the speed gradually drifts back toward 1x after the configured silence hold period.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this `speech-speed` directory.
5. Open a normal webpage with a video, click the extension icon, and enable it for that site.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 extension config |
| `content.js` | Content script: site state, video selection, audio analysis, speed control, overlay |
| `popup.html/js/css` | Extension popup: per-site toggle, status messages, settings |
| `background.js` | Service worker: per-tab badge updates |

## Configuration

The popup exposes:

- **此网站开启/关闭**: controls the current site's setting only.
- **显示悬浮窗**: shows or hides the in-page status overlay.
- **新网站默认自动启用**: enables the extension by default on new sites that do not yet have an explicit preference.
- **启用调试日志**: enables sanitized debug logs in DevTools; off by default.
- **目标语速** (4-14 syl/s, default 9): desired effective syllable rate.
- **最小倍速** (default 1.0): playback speed floor.
- **最大倍速** (default 3.5): playback speed ceiling.

Settings are validated before storage. Invalid values, `NaN`, or `minSpeed > maxSpeed` are corrected before they can affect playback.

## Site-level enable behavior

The extension no longer treats enable/disable as a single global switch. It stores per-site preferences in `chrome.storage.local`:

```js
sitePrefs: {
  "https://example.com": {
    enabled: true,
    updatedAt: 1780000000000
  }
}
```

The effective state is:

```js
sitePrefs[origin]?.enabled ?? defaultAutoEnable === true
```

This means **manual site choices win**. If default auto-enable is on but you turn a specific site off, that site stays off after reloads.

## Status and diagnostics

The popup now shows user-readable states instead of silently failing:

- current site / unsupported page
- current enable source
- waiting for video
- no video found
- no audio track
- audio capture failure
- running / paused state

The overlay shows the current speed, estimated original speech rate, speech/silence state, and a small recent history log. UI updates are throttled so the overlay is not rebuilt on every audio analysis tick.

## Performance behavior

The extension avoids work when disabled for the current site:

- no audio context
- no polling interval
- no overlay
- no broad DOM observer

When enabled:

- video changes are primarily detected through the browser's `play` event
- DOM mutation scans are filtered to mutations involving video elements
- audio analysis runs on a fixed polling interval
- overlay and badge updates are throttled
- badge updates are per tab, so one tab does not leak its speed into another tab's badge

## Tuning guide

Most detector parameters live in `content.js`.

| Parameter | Default | What it does |
|---|---:|---|
| `targetRate` | 9 | Desired effective syllable rate |
| `minSpeed` | 1.0 | Minimum playback speed |
| `maxSpeed` | 3.5 | Maximum playback speed |
| `smoothing` | 0.25 | Speed-change smoothing factor |
| `silenceHoldSec` | 3 | Silence duration before drifting toward 1x |
| `detector.hpAlpha` | 0.9 | High-pass coefficient for energy modulation |
| `detector.minCrossingInterval` | 70 ms | Minimum spacing between counted syllables |
| `detector.minEnergy` | 0.003 | Silence gate energy floor |
| `detector.windowSize` | 4000 ms | Sliding window for rate estimation |

If detection is noisy around music or background effects, raise `detector.minEnergy` or increase `detector.minCrossingInterval`. If quiet speech is missed, lower `detector.minEnergy` carefully.

## Known limitations

- **DRM-protected content**: encrypted media may block `captureStream()`.
- **Music and sound effects**: rhythmic non-speech audio can still look like syllables.
- **Multiple simultaneous speakers**: the detector measures aggregate syllable-rate modulation.
- **SPA navigation**: the extension re-attaches when videos change, but there can be a brief gap.
- **Restricted pages**: Chrome internal pages and some browser-controlled pages cannot receive the content script.

## Potential improvements

- Add a speech/music classifier or VAD to ignore non-speech audio.
- Use autocorrelation on the energy envelope for smoother rate estimation.
- Add keyboard shortcuts with `chrome.commands`.
- Add draggable/compact overlay modes.

## License

MIT
