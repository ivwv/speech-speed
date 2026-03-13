/**
 * AudioWorklet processor for real-time syllable rate detection.
 *
 * Algorithm: bandpass-filtered audio (done upstream) → RMS envelope →
 * adaptive-threshold peak picking → syllable count over sliding window.
 *
 * Each energy peak that exceeds a slow-moving background level by a
 * configurable ratio is counted as one syllable nucleus (vowel).
 */
class SyllableDetectorProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Fast envelope follower (tracks syllable-rate modulations)
    this.envelope = 0;
    this.envelopeAlpha = 0.15; // ~8 Hz cutoff at ~344 frames/s

    // Slow envelope (adaptive noise/background level)
    this.slowEnvelope = 0;
    this.slowAlpha = 0.003; // ~0.16 Hz – adapts over ~2 s

    // Peak detection
    this.aboveThreshold = false;
    this.lastPeakTime = -1000;
    this.minPeakInterval = 90;  // ms – caps at ~11 syl/s
    this.thresholdRatio = 1.5;  // peak must be 1.5× background (~3.5 dB)
    this.minEnergy = 0.003;     // absolute floor – below this is silence

    // Syllable timestamps (ms)
    this.peaks = [];
    this.windowSize = 5000; // ms – rate averaged over last 5 s

    // Reporting cadence
    this.lastReport = -1000;
    this.reportInterval = 250; // ms – 4 reports/s

    this.startTime = undefined;

    // Listen for parameter updates from main thread
    this.port.onmessage = (e) => {
      if (e.data.thresholdRatio !== undefined) this.thresholdRatio = e.data.thresholdRatio;
      if (e.data.minPeakInterval !== undefined) this.minPeakInterval = e.data.minPeakInterval;
      if (e.data.windowSize !== undefined) this.windowSize = e.data.windowSize;
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length || !input[0].length) return true;

    const samples = input[0];
    const now = currentTime * 1000; // ms

    if (this.startTime === undefined) this.startTime = now;

    // --- RMS energy of this frame ---
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sum / samples.length);

    // --- Update envelopes ---
    this.envelope += this.envelopeAlpha * (rms - this.envelope);
    this.slowEnvelope += this.slowAlpha * (rms - this.slowEnvelope);

    // --- Peak detection ---
    const threshold = Math.max(this.minEnergy, this.slowEnvelope * this.thresholdRatio);

    if (this.envelope > threshold) {
      if (!this.aboveThreshold && (now - this.lastPeakTime) >= this.minPeakInterval) {
        this.peaks.push(now);
        this.lastPeakTime = now;
      }
      this.aboveThreshold = true;
    } else {
      this.aboveThreshold = false;
    }

    // --- Periodic reporting ---
    if (now - this.lastReport >= this.reportInterval) {
      const cutoff = now - this.windowSize;
      this.peaks = this.peaks.filter((t) => t >= cutoff);

      const elapsed = Math.min(now - this.startTime, this.windowSize) / 1000;
      const rate = elapsed > 0.25 ? this.peaks.length / elapsed : 0;

      this.port.postMessage({
        syllableRate: rate,
        energy: this.envelope,
        threshold: threshold,
        peakCount: this.peaks.length,
      });

      this.lastReport = now;
    }

    return true;
  }
}

registerProcessor('syllable-detector', SyllableDetectorProcessor);
