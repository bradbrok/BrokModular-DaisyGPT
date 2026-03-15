// Audio Analyzer — gives the AI agent "ears" by extracting spectral features
// from the Web Audio API AnalyserNode output.

/**
 * AudioAnalyzer wraps an AnalyserNode and computes audio features
 * that can be fed to the LLM for intelligent sound design feedback.
 */
export class AudioAnalyzer {
  constructor() {
    this.analyserNode = null;
    this.sampleRate = 48000;
    this._timeBuf = null;
    this._freqBuf = null;
  }

  /**
   * Connect to an existing AnalyserNode (reuses the one from diagnostics).
   */
  connect(analyserNode, sampleRate = 48000) {
    this.analyserNode = analyserNode;
    this.sampleRate = sampleRate;
    const fftSize = analyserNode.fftSize || 2048;
    this._timeBuf = new Float32Array(fftSize);
    this._freqBuf = new Float32Array(fftSize / 2);
  }

  /**
   * Check if the analyzer is connected and ready.
   */
  get ready() {
    return this.analyserNode !== null;
  }

  /**
   * Take a snapshot of the current audio and return a feature object.
   * This is what gets sent to the LLM as context.
   */
  analyze() {
    if (!this.analyserNode) {
      return { error: 'No audio connected' };
    }

    this.analyserNode.getFloatTimeDomainData(this._timeBuf);
    this.analyserNode.getFloatFrequencyData(this._freqBuf);

    const rms = this._computeRMS();
    const zcr = this._computeZeroCrossingRate();
    const spectralCentroid = this._computeSpectralCentroid();
    const peakFrequency = this._computePeakFrequency();
    const spectralFlatness = this._computeSpectralFlatness();
    const crestFactor = this._computeCrestFactor();
    const bandEnergy = this._computeBandEnergy();
    const harmonicRatios = this._computeHarmonicRatios(peakFrequency);

    return {
      rmsLevel: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
      rmsLinear: rms,
      spectralCentroid: Math.round(spectralCentroid),
      peakFrequency: Math.round(peakFrequency),
      spectralFlatness: parseFloat(spectralFlatness.toFixed(4)),
      zeroCrossingRate: parseFloat(zcr.toFixed(4)),
      crestFactor: parseFloat(crestFactor.toFixed(2)),
      harmonicRatios: harmonicRatios.map(r => parseFloat(r.toFixed(3))),
      bandEnergy: {
        low: parseFloat(bandEnergy.low.toFixed(1)),
        mid: parseFloat(bandEnergy.mid.toFixed(1)),
        high: parseFloat(bandEnergy.high.toFixed(1)),
      },
      isSilent: rms < 0.001,
      timestamp: Date.now(),
    };
  }

  /**
   * Get a human-readable description of the current sound.
   * Useful for injecting into the system prompt.
   */
  describe() {
    const a = this.analyze();
    if (a.error) return 'Audio not connected.';
    if (a.isSilent) return 'The output is silent (no audio signal detected).';

    const parts = [];

    // Brightness
    if (a.spectralCentroid > 4000) parts.push('very bright/harsh');
    else if (a.spectralCentroid > 2000) parts.push('bright');
    else if (a.spectralCentroid > 800) parts.push('warm');
    else parts.push('dark/bassy');

    // Tonality
    if (a.spectralFlatness > 0.5) parts.push('noisy');
    else if (a.spectralFlatness > 0.2) parts.push('somewhat tonal');
    else parts.push('clearly tonal');

    // Level
    if (a.rmsLevel > -6) parts.push('loud');
    else if (a.rmsLevel > -18) parts.push('moderate level');
    else parts.push('quiet');

    // Pitch
    if (a.peakFrequency > 0 && a.spectralFlatness < 0.3) {
      parts.push(`fundamental ~${a.peakFrequency}Hz`);
    }

    // Band balance
    const { low, mid, high } = a.bandEnergy;
    if (low > mid + 6 && low > high + 6) parts.push('bass-heavy');
    else if (high > mid + 6 && high > low + 6) parts.push('treble-heavy');

    return `Current sound: ${parts.join(', ')}. RMS: ${a.rmsLevel.toFixed(1)} dBFS, Spectral centroid: ${a.spectralCentroid}Hz.`;
  }

  /**
   * Get the analysis as a compact JSON string for LLM context injection.
   */
  toContextString() {
    const a = this.analyze();
    if (a.error || a.isSilent) return this.describe();
    return `AUDIO ANALYSIS: ${this.describe()}\nRaw: ${JSON.stringify(a)}`;
  }

  // ─── Private feature computation ────────────────────────────────

  _computeRMS() {
    let sum = 0;
    for (let i = 0; i < this._timeBuf.length; i++) {
      sum += this._timeBuf[i] * this._timeBuf[i];
    }
    return Math.sqrt(sum / this._timeBuf.length);
  }

  _computeZeroCrossingRate() {
    let crossings = 0;
    for (let i = 1; i < this._timeBuf.length; i++) {
      if ((this._timeBuf[i] >= 0) !== (this._timeBuf[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / (this._timeBuf.length - 1);
  }

  _computeSpectralCentroid() {
    const binWidth = this.sampleRate / (this._freqBuf.length * 2);
    let weightedSum = 0;
    let totalPower = 0;

    for (let i = 0; i < this._freqBuf.length; i++) {
      // Convert from dB to linear power
      const power = Math.pow(10, this._freqBuf[i] / 10);
      const freq = (i + 0.5) * binWidth;
      weightedSum += freq * power;
      totalPower += power;
    }

    return totalPower > 0 ? weightedSum / totalPower : 0;
  }

  _computePeakFrequency() {
    const binWidth = this.sampleRate / (this._freqBuf.length * 2);
    let maxVal = -Infinity;
    let maxIdx = 0;

    for (let i = 1; i < this._freqBuf.length; i++) {
      if (this._freqBuf[i] > maxVal) {
        maxVal = this._freqBuf[i];
        maxIdx = i;
      }
    }

    // Parabolic interpolation for sub-bin accuracy
    if (maxIdx > 0 && maxIdx < this._freqBuf.length - 1) {
      const y0 = this._freqBuf[maxIdx - 1];
      const y1 = this._freqBuf[maxIdx];
      const y2 = this._freqBuf[maxIdx + 1];
      const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2));
      if (isFinite(d)) {
        return (maxIdx + d) * binWidth;
      }
    }

    return maxIdx * binWidth;
  }

  _computeSpectralFlatness() {
    let logSum = 0;
    let linSum = 0;
    let count = 0;

    for (let i = 1; i < this._freqBuf.length; i++) {
      const power = Math.pow(10, this._freqBuf[i] / 10);
      if (power > 1e-20) {
        logSum += Math.log(power);
        linSum += power;
        count++;
      }
    }

    if (count === 0 || linSum === 0) return 0;

    const geometricMean = Math.exp(logSum / count);
    const arithmeticMean = linSum / count;

    return arithmeticMean > 0 ? geometricMean / arithmeticMean : 0;
  }

  _computeCrestFactor() {
    let peak = 0;
    let rmsSum = 0;

    for (let i = 0; i < this._timeBuf.length; i++) {
      const abs = Math.abs(this._timeBuf[i]);
      if (abs > peak) peak = abs;
      rmsSum += this._timeBuf[i] * this._timeBuf[i];
    }

    const rms = Math.sqrt(rmsSum / this._timeBuf.length);
    return rms > 0 ? peak / rms : 0;
  }

  _computeBandEnergy() {
    const binWidth = this.sampleRate / (this._freqBuf.length * 2);
    let low = 0, mid = 0, high = 0;
    let lowCount = 0, midCount = 0, highCount = 0;

    for (let i = 0; i < this._freqBuf.length; i++) {
      const freq = (i + 0.5) * binWidth;
      const val = this._freqBuf[i]; // already in dB

      if (freq < 300) { low += val; lowCount++; }
      else if (freq < 3000) { mid += val; midCount++; }
      else { high += val; highCount++; }
    }

    return {
      low: lowCount > 0 ? low / lowCount : -100,
      mid: midCount > 0 ? mid / midCount : -100,
      high: highCount > 0 ? high / highCount : -100,
    };
  }

  _computeHarmonicRatios(fundamental) {
    if (fundamental <= 0 || fundamental > this.sampleRate / 4) {
      return [1, 0, 0, 0];
    }

    const binWidth = this.sampleRate / (this._freqBuf.length * 2);
    const ratios = [];

    for (let h = 1; h <= 4; h++) {
      const targetFreq = fundamental * h;
      const bin = Math.round(targetFreq / binWidth);
      if (bin >= 0 && bin < this._freqBuf.length) {
        ratios.push(Math.pow(10, this._freqBuf[bin] / 20));
      } else {
        ratios.push(0);
      }
    }

    // Normalize to fundamental
    const fundAmp = ratios[0] || 1;
    return ratios.map(r => fundAmp > 0 ? r / fundAmp : 0);
  }
}

/**
 * Analyze an offline audio buffer (for Sound-to-Patch feature).
 * Takes an AudioBuffer and returns feature analysis.
 */
export function analyzeAudioBuffer(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const channelData = audioBuffer.getChannelData(0);
  const fftSize = 2048;

  // Take a representative chunk from the middle
  const midPoint = Math.floor(channelData.length / 2);
  const start = Math.max(0, midPoint - fftSize / 2);
  const chunk = channelData.slice(start, start + fftSize);

  // Compute basic time-domain features
  let rmsSum = 0, peak = 0, crossings = 0;
  for (let i = 0; i < chunk.length; i++) {
    rmsSum += chunk[i] * chunk[i];
    const abs = Math.abs(chunk[i]);
    if (abs > peak) peak = abs;
    if (i > 0 && (chunk[i] >= 0) !== (chunk[i - 1] >= 0)) crossings++;
  }
  const rms = Math.sqrt(rmsSum / chunk.length);
  const zcr = crossings / (chunk.length - 1);

  // Estimate fundamental via autocorrelation
  const fundamental = estimatePitch(chunk, sampleRate);

  // Estimate envelope shape
  const envelope = estimateEnvelope(channelData, sampleRate);

  return {
    sampleRate,
    duration: audioBuffer.duration,
    rmsLevel: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    peakLevel: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    zeroCrossingRate: parseFloat(zcr.toFixed(4)),
    estimatedPitch: fundamental > 0 ? Math.round(fundamental) : null,
    envelope,
    isSilent: rms < 0.001,
  };
}

/**
 * Pitch estimation via autocorrelation.
 */
function estimatePitch(samples, sampleRate) {
  const minLag = Math.floor(sampleRate / 4000); // Max 4kHz
  const maxLag = Math.floor(sampleRate / 40);   // Min 40Hz
  const n = samples.length;

  let bestCorr = 0;
  let bestLag = 0;

  for (let lag = minLag; lag <= Math.min(maxLag, n / 2); lag++) {
    let corr = 0;
    for (let i = 0; i < n - lag; i++) {
      corr += samples[i] * samples[i + lag];
    }
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  return bestLag > 0 ? sampleRate / bestLag : 0;
}

/**
 * Estimate the amplitude envelope shape (attack, sustain level, etc.)
 */
function estimateEnvelope(samples, sampleRate) {
  const blockSize = Math.floor(sampleRate * 0.01); // 10ms blocks
  const blocks = Math.floor(samples.length / blockSize);
  const rmsBlocks = [];

  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const offset = b * blockSize;
    for (let i = 0; i < blockSize; i++) {
      sum += samples[offset + i] * samples[offset + i];
    }
    rmsBlocks.push(Math.sqrt(sum / blockSize));
  }

  if (rmsBlocks.length === 0) return { shape: 'unknown' };

  const peakBlock = rmsBlocks.indexOf(Math.max(...rmsBlocks));
  const peakRatio = peakBlock / rmsBlocks.length;
  const peakVal = rmsBlocks[peakBlock];

  // Check sustain level
  const lastQuarter = rmsBlocks.slice(Math.floor(rmsBlocks.length * 0.75));
  const sustainLevel = lastQuarter.reduce((a, b) => a + b, 0) / lastQuarter.length;
  const sustainRatio = peakVal > 0 ? sustainLevel / peakVal : 0;

  let shape;
  if (peakRatio < 0.1 && sustainRatio > 0.5) shape = 'sustained (organ-like)';
  else if (peakRatio < 0.1 && sustainRatio < 0.2) shape = 'percussive (fast decay)';
  else if (peakRatio < 0.3) shape = 'plucked (medium decay)';
  else shape = 'swelling (slow attack)';

  return {
    shape,
    attackTime: (peakBlock * blockSize / sampleRate * 1000).toFixed(0) + 'ms',
    sustainRatio: parseFloat(sustainRatio.toFixed(2)),
  };
}
