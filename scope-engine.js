// scope-engine.js — DC/AC oscilloscope engine with auto signal classification
// Provides: SignalClassifier, RingBuffer, ScopeRenderer

// ─── Signal Classifier ────────────────────────────────────────────

/**
 * Classify a time-domain buffer as DC, LFO, or audio-rate signal.
 * Uses zero-crossing rate and autocorrelation for frequency estimation.
 *
 * @param {Float32Array} timeData - time-domain samples (normalized -1..+1)
 * @param {number} sampleRate - audio sample rate (e.g. 48000)
 * @returns {{ type: 'dc'|'lfo'|'audio', frequency: number, dcOffset: number, amplitude: number }}
 */
export function classifySignal(timeData, sampleRate = 48000) {
  const len = timeData.length;
  if (len < 2) return { type: 'dc', frequency: 0, dcOffset: 0, amplitude: 0 };

  // DC offset (mean)
  let sum = 0;
  for (let i = 0; i < len; i++) sum += timeData[i];
  const dcOffset = sum / len;

  // Amplitude (RMS of AC component)
  let acSumSq = 0;
  let peak = 0;
  for (let i = 0; i < len; i++) {
    const ac = timeData[i] - dcOffset;
    acSumSq += ac * ac;
    const abs = Math.abs(ac);
    if (abs > peak) peak = abs;
  }
  const amplitude = Math.sqrt(acSumSq / len);

  // Zero-crossing rate (crossings per sample)
  let crossings = 0;
  for (let i = 1; i < len; i++) {
    if ((timeData[i] >= dcOffset) !== (timeData[i - 1] >= dcOffset)) {
      crossings++;
    }
  }
  const zcr = crossings / (len - 1);

  // Frequency estimation via autocorrelation
  const frequency = estimateFrequencyAutocorr(timeData, sampleRate, dcOffset);

  // Variance check for DC detection
  const variance = acSumSq / len;

  // Classification logic
  let type;
  if (variance < 0.0001 && zcr < 0.0005) {
    // Near-zero variance, very few crossings = DC
    type = 'dc';
  } else if (zcr < 0.001 || frequency < 20) {
    // Low crossing rate or sub-audio frequency = LFO
    type = 'lfo';
  } else {
    type = 'audio';
  }

  return { type, frequency, dcOffset, amplitude };
}

/**
 * Estimate fundamental frequency via autocorrelation.
 * Searches for the first peak in the autocorrelation function after the initial drop.
 */
function estimateFrequencyAutocorr(timeData, sampleRate, dcOffset) {
  const len = timeData.length;
  const maxLag = Math.min(Math.floor(len / 2), Math.floor(sampleRate / 2)); // down to 2 Hz
  const minLag = Math.max(1, Math.floor(sampleRate / 20000)); // up to 20kHz

  // Normalized autocorrelation
  let energy = 0;
  for (let i = 0; i < len; i++) {
    const v = timeData[i] - dcOffset;
    energy += v * v;
  }
  if (energy < 1e-10) return 0;

  let bestCorr = -1;
  let bestLag = 0;
  let prevCorr = 1;
  let fallingFromPeak = false;

  for (let lag = minLag; lag < maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < len - lag; i++) {
      corr += (timeData[i] - dcOffset) * (timeData[i + lag] - dcOffset);
    }
    corr /= energy;

    // Look for first peak after initial dip
    if (corr < prevCorr) {
      fallingFromPeak = true;
    }
    if (fallingFromPeak && corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
    // If we found a good peak and it starts falling again, stop
    if (fallingFromPeak && bestCorr > 0.3 && corr < bestCorr * 0.9) {
      break;
    }
    prevCorr = corr;
  }

  return bestLag > 0 && bestCorr > 0.1 ? sampleRate / bestLag : 0;
}


// ─── Ring Buffer ──────────────────────────────────────────────────

/**
 * Ring buffer for accumulating time-domain samples.
 * Used for LFO/DC modes where we need longer time windows than the 2048-sample analyser buffer.
 */
export class RingBuffer {
  /**
   * @param {number} maxSeconds - maximum history to store
   * @param {number} sampleRate - audio sample rate
   */
  constructor(maxSeconds = 10, sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.maxSamples = Math.ceil(maxSeconds * sampleRate);
    this.buffer = new Float32Array(this.maxSamples);
    this.writePos = 0;
    this.filled = 0; // how many valid samples we have
  }

  /** Push a chunk of new samples into the ring buffer. */
  push(samples) {
    const len = samples.length;
    for (let i = 0; i < len; i++) {
      this.buffer[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % this.maxSamples;
    }
    this.filled = Math.min(this.filled + len, this.maxSamples);
  }

  /** Get the last N samples as a contiguous Float32Array. */
  getLastN(n) {
    const count = Math.min(n, this.filled);
    const result = new Float32Array(count);
    let readPos = (this.writePos - count + this.maxSamples) % this.maxSamples;
    for (let i = 0; i < count; i++) {
      result[i] = this.buffer[readPos];
      readPos = (readPos + 1) % this.maxSamples;
    }
    return result;
  }

  /** Get all available samples. */
  getAll() {
    return this.getLastN(this.filled);
  }

  /** Get the number of seconds of data available. */
  get availableSeconds() {
    return this.filled / this.sampleRate;
  }

  /** Clear the buffer. */
  clear() {
    this.writePos = 0;
    this.filled = 0;
  }
}


// ─── Scope Renderer ───────────────────────────────────────────────

/**
 * Enhanced oscilloscope renderer with DC/AC/LFO mode support.
 */
export class ScopeRenderer {
  constructor(canvas, analyserNode, sampleRate = 48000) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.analyserNode = analyserNode;
    this.sampleRate = sampleRate;

    // Analyser buffer
    const fftSize = analyserNode ? analyserNode.fftSize : 2048;
    this.timeBuf = new Float32Array(fftSize);

    // Ring buffer for slow signals (10 seconds max)
    this.ringBuffer = new RingBuffer(10, sampleRate);

    // State
    this.classification = { type: 'audio', frequency: 0, dcOffset: 0, amplitude: 0 };
    this.modeOverride = 'auto'; // 'auto', 'dc', 'ac'
    this.smoothedClassification = null;
    this._classifyCounter = 0;
    this._classifyInterval = 6; // classify every N frames to avoid flicker

    // Colors
    this.colors = {
      audio: '#d4a843',  // gold
      lfo: '#00d4ff',    // cyan
      dc: '#44cc66',     // green
      bg: '#0a0a0a',
      grid: '#262626',
      gridText: '#555555',
      centerLine: '#333333',
      badge: '#ffffff',
    };
  }

  /** Update analyser node reference (e.g., after audio restart). */
  setAnalyserNode(node, sampleRate) {
    this.analyserNode = node;
    this.sampleRate = sampleRate || this.sampleRate;
    if (node) {
      this.timeBuf = new Float32Array(node.fftSize);
      this.ringBuffer = new RingBuffer(10, this.sampleRate);
    }
  }

  /** Set mode override: 'auto', 'dc', or 'ac'. */
  setMode(mode) {
    this.modeOverride = mode;
  }

  /** Main render call — grab data, classify, draw. */
  render() {
    if (!this.analyserNode) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;

    // Grab fresh time-domain data
    this.analyserNode.getFloatTimeDomainData(this.timeBuf);

    // Feed into ring buffer for LFO/DC modes
    this.ringBuffer.push(this.timeBuf);

    // Classify signal periodically to avoid flickering
    this._classifyCounter++;
    if (this._classifyCounter >= this._classifyInterval) {
      this._classifyCounter = 0;
      const raw = classifySignal(this.timeBuf, this.sampleRate);
      this._smoothClassification(raw);
    }

    // Determine effective mode
    const effectiveType = this._getEffectiveType();

    // Clear
    ctx.fillStyle = this.colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Draw based on mode
    switch (effectiveType) {
      case 'dc':
        this._renderDC(w, h);
        break;
      case 'lfo':
        this._renderLFO(w, h);
        break;
      default:
        this._renderAudio(w, h);
        break;
    }

    // Overlay: axes, badge, info
    this._drawAxes(w, h, effectiveType);
    this._drawBadge(w, h, effectiveType);
  }

  // ─── Private rendering methods ──────────────────────────────────

  _smoothClassification(raw) {
    if (!this.smoothedClassification) {
      this.smoothedClassification = { ...raw };
      this.classification = { ...raw };
      return;
    }
    // Smooth frequency with exponential moving average
    const alpha = 0.3;
    this.smoothedClassification.frequency =
      alpha * raw.frequency + (1 - alpha) * this.smoothedClassification.frequency;
    this.smoothedClassification.dcOffset =
      alpha * raw.dcOffset + (1 - alpha) * this.smoothedClassification.dcOffset;
    this.smoothedClassification.amplitude =
      alpha * raw.amplitude + (1 - alpha) * this.smoothedClassification.amplitude;
    this.smoothedClassification.type = raw.type;
    this.classification = { ...this.smoothedClassification };
  }

  _getEffectiveType() {
    if (this.modeOverride === 'dc') return 'dc';
    if (this.modeOverride === 'ac') return this.classification.type === 'dc' ? 'audio' : this.classification.type;
    return this.classification.type;
  }

  /** Audio-rate rendering: rising zero-crossing trigger, 2048-sample window. */
  _renderAudio(w, h) {
    const data = this.timeBuf;
    const dcOffset = this.modeOverride === 'ac' ? this.classification.dcOffset : 0;

    // Center line
    this._drawCenterLine(w, h);

    // Find rising zero-crossing for trigger
    let triggerIndex = 0;
    for (let i = 1; i < data.length - w; i++) {
      if (data[i - 1] - dcOffset <= 0 && data[i] - dcOffset > 0) {
        triggerIndex = i;
        break;
      }
    }

    // Waveform
    const color = this.colors.audio;
    const sliceLen = Math.min(w, data.length - triggerIndex);
    this._drawWaveformSlice(data, triggerIndex, sliceLen, w, h, color, dcOffset);
  }

  /** LFO rendering: longer time window from ring buffer, trigger on DC offset crossing. */
  _renderLFO(w, h) {
    const freq = this.classification.frequency || 1;
    const dcOffset = this.modeOverride === 'ac' ? this.classification.dcOffset : 0;

    // Show 2-4 periods; minimum 0.5s, max 10s
    const periodsToShow = 3;
    const desiredSeconds = Math.min(10, Math.max(0.5, periodsToShow / Math.max(freq, 0.1)));
    const samplesNeeded = Math.ceil(desiredSeconds * this.sampleRate);
    const data = this.ringBuffer.getLastN(samplesNeeded);

    if (data.length < 2) return;

    this._drawCenterLine(w, h);

    // Find trigger: rising crossing of DC offset
    const mean = this.classification.dcOffset;
    let triggerIndex = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i - 1] <= mean && data[i] > mean) {
        triggerIndex = i;
        break;
      }
    }

    const color = this.colors.lfo;
    const sliceLen = data.length - triggerIndex;
    this._drawWaveformSlice(data, triggerIndex, sliceLen, w, h, color, dcOffset);
  }

  /** DC rendering: full buffer with mean level line. */
  _renderDC(w, h) {
    const data = this.ringBuffer.getLastN(Math.min(this.sampleRate * 2, this.ringBuffer.filled));
    if (data.length < 2) return;

    this._drawCenterLine(w, h);

    const dcOffset = this.modeOverride === 'ac' ? this.classification.dcOffset : 0;
    const color = this.colors.dc;

    // Draw waveform (no trigger, just render everything)
    this._drawWaveformSlice(data, 0, data.length, w, h, color, dcOffset);

    // Draw mean level line
    const mean = this.classification.dcOffset - dcOffset;
    const meanY = (1 - mean) * h / 2;
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.dc;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, meanY);
    ctx.lineTo(w, meanY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label the DC level
    ctx.fillStyle = this.colors.dc;
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`DC: ${this.classification.dcOffset.toFixed(3)}`, w - 4, meanY - 4);
  }

  /** Draw a waveform slice to canvas. */
  _drawWaveformSlice(data, startIdx, length, w, h, color, dcOffset) {
    if (length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();

    // Downsample if needed — pick every Nth sample when length >> w
    const step = Math.max(1, Math.floor(length / (w * 2)));

    for (let px = 0; px < w; px++) {
      const sampleIdx = startIdx + Math.floor((px / w) * length);
      if (sampleIdx >= data.length) break;
      const sample = data[sampleIdx] - dcOffset;
      const y = (1 - sample) * h / 2;
      if (px === 0) ctx.moveTo(px, y);
      else ctx.lineTo(px, y);
    }
    ctx.stroke();
  }

  /** Draw the zero reference center line. */
  _drawCenterLine(w, h) {
    const ctx = this.ctx;
    ctx.strokeStyle = this.colors.centerLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }

  /** Draw time and voltage axes. */
  _drawAxes(w, h, type) {
    const ctx = this.ctx;
    ctx.fillStyle = this.colors.gridText;
    ctx.font = '8px monospace';

    // Voltage axis labels
    ctx.textAlign = 'left';
    ctx.fillText('+1.0', 2, 10);
    ctx.fillText(' 0.0', 2, h / 2 + 3);
    ctx.fillText('-1.0', 2, h - 3);

    // Time axis labels
    ctx.textAlign = 'center';
    let totalTime;
    let unit;

    if (type === 'audio') {
      totalTime = (this.timeBuf.length / this.sampleRate) * 1000; // ms
      unit = 'ms';
    } else if (type === 'lfo') {
      const freq = this.classification.frequency || 1;
      const periods = 3;
      totalTime = Math.min(10, Math.max(0.5, periods / Math.max(freq, 0.1)));
      unit = 's';
    } else {
      // DC: show 2 seconds
      totalTime = Math.min(2, this.ringBuffer.availableSeconds);
      unit = 's';
    }

    // Draw 5 time divisions
    for (let i = 0; i <= 4; i++) {
      const x = (i / 4) * w;
      const t = (i / 4) * totalTime;
      const label = unit === 'ms' ? `${t.toFixed(1)}${unit}` : `${t.toFixed(1)}${unit}`;

      // Tick mark
      ctx.strokeStyle = this.colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, h - 8);
      ctx.lineTo(x, h);
      ctx.stroke();

      // Label (skip first to avoid overlapping voltage labels)
      if (i > 0) {
        ctx.fillStyle = this.colors.gridText;
        ctx.fillText(label, x, h - 1);
      }
    }
  }

  /** Draw signal type badge and frequency info. */
  _drawBadge(w, h, type) {
    const ctx = this.ctx;
    const freq = this.classification.frequency;
    const dcOffset = this.classification.dcOffset;

    // Badge text
    let badgeText;
    let badgeColor;
    switch (type) {
      case 'dc':
        badgeText = 'DC';
        badgeColor = this.colors.dc;
        break;
      case 'lfo':
        badgeText = `LFO ~${freq.toFixed(1)}Hz`;
        badgeColor = this.colors.lfo;
        break;
      default:
        badgeText = freq > 0 ? `Audio ~${Math.round(freq)}Hz` : 'Audio';
        badgeColor = this.colors.audio;
        break;
    }

    // Draw badge background
    ctx.font = 'bold 9px monospace';
    const textWidth = ctx.measureText(badgeText).width;
    const badgeX = w - textWidth - 10;
    const badgeY = 2;
    const badgeH = 14;
    const badgeW = textWidth + 8;

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
    ctx.strokeStyle = badgeColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);

    ctx.fillStyle = badgeColor;
    ctx.textAlign = 'left';
    ctx.fillText(badgeText, badgeX + 4, badgeY + 10);

    // DC offset indicator (when significant)
    if (Math.abs(dcOffset) > 0.01) {
      const offsetText = `DC: ${dcOffset > 0 ? '+' : ''}${dcOffset.toFixed(3)}`;
      ctx.font = '8px monospace';
      ctx.fillStyle = this.colors.gridText;
      ctx.textAlign = 'right';
      ctx.fillText(offsetText, w - 4, badgeY + badgeH + 12);
    }

    // Mode indicator if overridden
    if (this.modeOverride !== 'auto') {
      ctx.font = '8px monospace';
      ctx.fillStyle = '#888';
      ctx.textAlign = 'left';
      ctx.fillText(this.modeOverride.toUpperCase(), 2, badgeY + 24);
    }
  }
}
