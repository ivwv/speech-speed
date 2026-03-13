# Speech Speed

A Chrome extension that dynamically adjusts video playback speed based on how fast the speaker is talking. Slow speakers get sped up more; fast speakers get sped up less. The goal is to normalize all speech to a comfortable listening rate so you can consume video content faster without it becoming unintelligible during rapid passages.

## How it works

### Audio capture

The extension's content script finds the largest `<video>` element on the page and taps its audio output using `HTMLMediaElement.captureStream()`. This returns a `MediaStream` without interrupting normal playback. The stream is fed into a Web Audio API graph:

```
video.captureStream()
  → MediaStreamSource
    → BiquadFilter (highpass 300 Hz)
      → BiquadFilter (lowpass 3000 Hz)
        → AnalyserNode (polled at ~33 Hz)
```

The 300-3000 Hz bandpass isolates the vowel formant region where syllable energy is concentrated, rejecting low-frequency rumble and high-frequency noise.

### Syllable rate detection

The core algorithm measures **syllable rate** by analyzing modulation in the energy envelope. It went through three iterations:

**v1 (abandoned): Threshold peak-counting.** Computed a smoothed RMS envelope and counted peaks above an adaptive threshold. Failed because fast continuous speech maintains high energy without deep dips between syllables, so the detector saw one long above-threshold region instead of individual syllables. This systematically undercounted fast speech.

**v2 (abandoned): AudioWorklet-based detection.** The same peak-counting algorithm running in an AudioWorklet for off-main-thread processing. Blocked by YouTube's Content Security Policy, which rejects blob: URLs for script loading.

**v3 (current): Energy-envelope modulation analysis.** Instead of looking for individual peaks, this approach isolates the **syllable-rate modulation** of the energy envelope using a high-pass filter, then counts zero-crossings of the filtered signal.

The algorithm:

1. **Compute RMS energy** over each 2048-sample window (~21 ms at 96 kHz) via `AnalyserNode.getFloatTimeDomainData()`.

2. **Smooth envelope** with a first-order IIR low-pass (alpha=0.3) for silence detection and display.

3. **High-pass filter the raw RMS** to remove DC and slow-varying level, leaving only syllable-rate modulation (2-10 Hz). This is a first-order IIR high-pass:
   ```
   filtered[n] = alpha * (filtered[n-1] + rms[n] - rms[n-1])
   ```
   With alpha=0.9 at 33 Hz polling, the cutoff is ~0.5 Hz. Everything above 0.5 Hz passes through, including the 2-10 Hz syllable modulation.

4. **Count positive-going zero-crossings** of the filtered signal. Each time the filtered energy rises from below zero to above zero, one syllable nucleus (vowel) has been detected. A minimum interval of 70 ms between crossings caps the maximum detectable rate at ~14 syl/s.

5. **Compute syllable rate** as crossings per second over a 4-second sliding window.

This approach works because even during continuous fast speech, the energy envelope oscillates between syllable nuclei (vowels, high energy) and inter-syllabic transitions (consonants, lower energy). The high-pass filter extracts this oscillation regardless of absolute level, and zero-crossing counting is inherently robust to amplitude variations.

### Speed mapping

The detected syllable rate is converted to a playback speed:

```
naturalRate = measuredRate / currentPlaybackSpeed
targetSpeed = targetSyllableRate / naturalRate
targetSpeed = clamp(targetSpeed, minSpeed, maxSpeed)
currentSpeed += smoothingAlpha * (targetSpeed - currentSpeed)
```

The `measuredRate / currentPlaybackSpeed` correction accounts for the fact that `captureStream()` reflects the current playback rate: if the video plays at 2x, the audio arrives at 2x speed, so measured syllables come twice as fast. Dividing by the current speed recovers the speaker's natural rate.

With the default target of 9 syl/s:

| Speaker pace | Natural rate | Playback speed |
|---|---|---|
| Very slow | ~2.5 syl/s | 3.50x (capped) |
| Slow | ~3.0 syl/s | 3.00x |
| Normal | ~4.5 syl/s | 2.00x |
| Fast | ~6.0 syl/s | 1.50x |
| Very fast | ~8.0 syl/s | 1.12x |

During silence (low energy or low syllable rate for more than 3 seconds), the speed gradually drifts back toward 1x.

### Smoothing

Speed changes use an exponential moving average (alpha=0.25, updated ~33 times/sec) to prevent jarring jumps. This gives a time constant of roughly 1 second: fast enough to adapt when speakers change, slow enough that brief pauses don't cause stuttery speed oscillation.

## Installation

1. Clone or download this repository
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `speech-speed` directory
5. Navigate to any page with a video, click the extension icon, and toggle **ON**

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Manifest V3 extension config |
| `content.js` | Content script: audio capture, syllable detection, speed control, diagnostic overlay |
| `popup.html/js/css` | Extension popup: on/off toggle and settings sliders |
| `syllable-worklet.js` | (Legacy, unused) AudioWorklet from v2 approach |

## Configuration

The popup exposes three sliders:

- **Target rate** (4-14 syl/s, default 9): the desired effective syllable rate you hear. Higher = more speedup across the board. Lower = gentler.
- **Min speed** (1-2x, default 1.0): floor for playback rate. Set to 1.0 to never slow below normal.
- **Max speed** (1.5-5x, default 3.5): ceiling for playback rate. Protects against extreme speedup on very slow speakers.

Settings persist in `chrome.storage.local`.

## Diagnostic overlay

When enabled, a dark panel appears in the top-right corner of the page showing:

- **Speed** (large green number): current playback multiplier
- **syl/s** (large blue number): estimated natural syllable rate of the speaker
- **State**: SPEAKING (green) or SILENCE with duration (amber)
- **Energy bar**: real-time audio energy level
- **History log**: scrolling list of rate-to-speed mappings, one per second, most recent at bottom (bold). Lets you see at a glance how the speed changes as different speakers talk.
- **Stats**: zero-crossing count, poll tick count, pipeline stage

## Tuning guide

All tunable parameters are in `content.js`. Here are the ones most worth adjusting:

### Detector parameters (in the `detector` object)

| Parameter | Default | What it does | How to tune |
|---|---|---|---|
| `hpAlpha` | 0.9 | High-pass filter coefficient. Higher = lower cutoff = passes more low-frequency modulation. | If detecting too many spurious syllables in music/ambient noise, lower toward 0.8. If missing syllables in very slow speech (<2 syl/s), raise toward 0.95. |
| `minCrossingInterval` | 70 ms | Minimum time between detected syllables. Caps max detectable rate at ~14 syl/s. | Raise to 100 ms if getting false positives from music. Lower to 50 ms if very fast speech (>10 syl/s natural) is being undercounted. |
| `minEnergy` | 0.003 | Absolute energy floor for silence gating. Below this, no syllables are counted. | Raise if background noise or music is triggering false detections. Lower if quiet speech is being missed. Inspect the "Energy" readout in the overlay. |
| `envelopeAlpha` | 0.3 | Smoothing for the envelope used in silence detection. | Rarely needs changing. Higher = more responsive silence detection, lower = more sluggish. |
| `windowSize` | 4000 ms | Sliding window for rate computation. | Shorter (2000 ms) = faster adaptation to speaker changes, but noisier rate estimate. Longer (6000 ms) = smoother but slower to react. |

### Speed control parameters (in `DEFAULTS`)

| Parameter | Default | What it does | How to tune |
|---|---|---|---|
| `targetRate` | 9 syl/s | Desired effective syllable rate. The speed adjusts so you hear syllables at roughly this rate. | This is the primary dial. 7 = moderate speedup. 9 = aggressive. 12 = very aggressive. Normal English speech is ~4-5 syl/s. |
| `smoothing` | 0.25 | EMA alpha for speed changes. | Lower (0.1) = slower, more gradual transitions. Higher (0.4) = snappier but potentially jittery. |
| `silenceHoldSec` | 3 | Seconds of silence before speed starts drifting toward 1x. | Raise if speed is resetting during natural pauses in speech. Lower if speed hangs too long after someone stops talking. |
| `minSpeed` / `maxSpeed` | 1.0 / 3.5 | Speed clamps. | Adjust based on your tolerance. Some people can track 4-5x; others top out at 2x. |

### Bandpass filter

The highpass (300 Hz) and lowpass (3000 Hz) in the audio pipeline isolate the vowel formant region. If you're seeing poor detection on content with unusual audio characteristics:

- **Lots of bass bleed triggering false syllables**: raise highpass to 400-500 Hz
- **Missing high-pitched speakers**: raise lowpass to 4000 Hz
- **Sibilance ("s", "sh") being counted as syllables**: lower lowpass to 2500 Hz

### Polling rate

The `setInterval` in `setupAudio` runs at 30 ms (~33 Hz). This is well above the Nyquist rate for syllable detection (max ~14 syl/s = 28 Hz Nyquist). Lowering to 50 ms saves CPU at the cost of reduced maximum detectable rate. Raising to 15 ms provides finer time resolution but minimal practical benefit.

## Known limitations

- **DRM-protected content** (Netflix, Disney+, etc.): `captureStream()` is blocked on encrypted media. The extension will not work on these sites.
- **Music and sound effects**: The detector may count rhythmic beats as syllables. The bandpass filter and silence gating help, but aren't perfect. A Voice Activity Detection model (e.g., Silero VAD at ~2 MB) could improve this.
- **Multiple simultaneous speakers**: The detector measures aggregate syllable rate across all speakers. This is a reasonable degradation since overlapping speech is hard to parse at any speed.
- **Non-speech audio content**: Podcasts with heavy background music or sound design may see inaccurate rate detection.
- **SPA navigation**: On YouTube and similar single-page apps, the extension re-attaches when the video element changes. There may be a brief 1-2 second gap during navigation.

## Potential improvements

- **Silero VAD integration**: Adding the ~2 MB Silero VAD model via onnxruntime-web could gate the detector to only count syllables during confirmed speech, ignoring music and ambient sound.
- **Autocorrelation-based rate estimation**: Instead of counting zero-crossings, compute the autocorrelation of the energy envelope to find the dominant modulation frequency. This would be more robust to noise and provide smoother rate estimates.
- **Per-speaker adaptation**: If combined with speaker diarization, the extension could maintain separate rate estimates for each speaker and switch speeds instantly when the active speaker changes.
- **Keyboard shortcut toggle**: Add `chrome.commands` for quick enable/disable without opening the popup.

## License

MIT
