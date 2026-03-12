// AudioWorklet processor for daisy-gpt browser edition
// Runs compiled WASM patches in the audio thread

class DaisyProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.wasmInstance = null;
    this.ready = false;
    this.rmsLevel = 0;
    this.frameCount = 0;

    // MIDI state tracked in audio thread
    this.pitchCV = 0;
    this.velocity = 0;
    this.pitchBend = 0;
    this.midiGate = false;

    this.port.onmessage = (e) => {
      const { type } = e.data;

      if (type === 'load-wasm') {
        this._loadWasm(e.data.wasmBytes);
      } else if (type === 'set-knob') {
        if (this.wasmInstance) {
          this.wasmInstance.exports.setKnob(e.data.index, e.data.value);
        }
      } else if (type === 'set-gate') {
        if (this.wasmInstance) {
          this.wasmInstance.exports.setGate(e.data.index, e.data.value ? 1 : 0);
        }
      } else if (type === 'midi-note-on') {
        this.pitchCV = e.data.pitchCV;
        this.velocity = e.data.velocity;
        this.midiGate = true;
        if (this.wasmInstance) {
          const ex = this.wasmInstance.exports;
          if (ex.setPitchCV) ex.setPitchCV(this.pitchCV);
          if (ex.setVelocity) ex.setVelocity(this.velocity);
          ex.setGate(0, 1);
        }
      } else if (type === 'midi-note-off') {
        this.midiGate = false;
        if (this.wasmInstance) {
          this.wasmInstance.exports.setGate(0, 0);
        }
      } else if (type === 'midi-pitchbend') {
        this.pitchBend = e.data.value;
        if (this.wasmInstance && this.wasmInstance.exports.setPitchBend) {
          this.wasmInstance.exports.setPitchBend(this.pitchBend);
        }
      } else if (type === 'midi-cc') {
        if (this.wasmInstance) {
          this.wasmInstance.exports.setKnob(e.data.knobIndex, e.data.value);
        }
        this.port.postMessage({ type: 'midi-cc-applied', knobIndex: e.data.knobIndex, value: e.data.value });
      } else if (type === 'stop') {
        this.ready = false;
        this.wasmInstance = null;
      }
    };
  }

  async _loadWasm(wasmBytes) {
    try {
      const module = await WebAssembly.compile(wasmBytes);
      const moduleImports = WebAssembly.Module.imports(module);

      // Build import object dynamically based on what the module needs
      const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });
      const importObject = this._buildImportObject(moduleImports, memory);

      const instance = await WebAssembly.instantiate(module, importObject);
      this.wasmInstance = instance;

      // Call global constructors if present (clang-compiled WASM)
      if (instance.exports.__wasm_call_ctors) {
        instance.exports.__wasm_call_ctors();
      }

      // Call init if exported
      if (instance.exports.init) {
        instance.exports.init(sampleRate);
      }

      this.ready = true;
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.port.postMessage({ type: 'error', message: err.message });
    }
  }

  // Dynamically build import object matching what the WASM module expects
  _buildImportObject(moduleImports, memory) {
    const importObject = {};

    for (const imp of moduleImports) {
      if (!importObject[imp.module]) importObject[imp.module] = {};

      if (imp.kind === 'memory') {
        importObject[imp.module][imp.name] = memory;
      } else if (imp.kind === 'global') {
        if (imp.name === '__stack_pointer') {
          importObject[imp.module][imp.name] =
            new WebAssembly.Global({ value: 'i32', mutable: true }, 65536);
        } else {
          importObject[imp.module][imp.name] =
            new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
        }
      } else if (imp.kind === 'function') {
        importObject[imp.module][imp.name] =
          this._getImportFn(imp.module, imp.name, memory);
      }
    }

    return importObject;
  }

  // Provide import functions for math, C stdlib, and WASI
  _getImportFn(mod, name, memory) {
    // Math functions (float and double variants)
    const math = {
      sinf: Math.sin, sin: Math.sin,
      cosf: Math.cos, cos: Math.cos,
      tanf: Math.tan, tan: Math.tan,
      expf: Math.exp, exp: Math.exp,
      logf: Math.log, log: Math.log,
      log2f: Math.log2, log2: Math.log2,
      log10f: Math.log10, log10: Math.log10,
      powf: Math.pow, pow: Math.pow,
      sqrtf: Math.sqrt, sqrt: Math.sqrt,
      fabsf: Math.abs, fabs: Math.abs,
      fmodf: (a, b) => a % b, fmod: (a, b) => a % b,
      floorf: Math.floor, floor: Math.floor,
      ceilf: Math.ceil, ceil: Math.ceil,
      roundf: Math.round, round: Math.round,
      fminf: Math.min, fmin: Math.min,
      fmaxf: Math.max, fmax: Math.max,
      atanf: Math.atan, atan: Math.atan,
      atan2f: Math.atan2, atan2: Math.atan2,
      asinf: Math.asin, asin: Math.asin,
      acosf: Math.acos, acos: Math.acos,
      tanhf: Math.tanh, tanh: Math.tanh,
      sinhf: Math.sinh, sinh: Math.sinh,
      coshf: Math.cosh, cosh: Math.cosh,
      truncf: Math.trunc, trunc: Math.trunc,
      cbrtf: Math.cbrt, cbrt: Math.cbrt,
      hypotf: Math.hypot, hypot: Math.hypot,
      copysignf: (x, y) => Math.sign(y) * Math.abs(x),
      ldexpf: (x, n) => x * Math.pow(2, n),
      frexpf: () => 0,
    };
    if (math[name]) return math[name];

    // C stdlib
    if (name === 'rand') return () => (Math.random() * 2147483647) | 0;
    if (name === 'srand') return () => {};
    if (name === 'abs') return Math.abs;
    if (name === 'memset') return (ptr, val, len) => {
      const view = new Uint8Array(memory.buffer);
      view.fill(val, ptr, ptr + len);
      return ptr;
    };
    if (name === 'memcpy' || name === 'memmove') return (dst, src, len) => {
      const view = new Uint8Array(memory.buffer);
      view.copyWithin(dst, src, src + len);
      return dst;
    };
    if (name === 'memcmp') return (a, b, len) => {
      const view = new Uint8Array(memory.buffer);
      for (let i = 0; i < len; i++) {
        if (view[a + i] !== view[b + i]) return view[a + i] - view[b + i];
      }
      return 0;
    };

    // WASI stubs (for both wasi_unstable and wasi_snapshot_preview1)
    if (mod.startsWith('wasi')) {
      if (name === 'proc_exit') return () => {};
      if (name === 'fd_write') return () => 0;
      if (name === 'fd_read') return () => 0;
      if (name === 'fd_close') return () => 0;
      if (name === 'fd_seek') return () => 0;
      if (name === 'fd_fdstat_get') return () => 0;
      if (name === 'fd_prestat_get') return () => 8; // EBADF
      if (name === 'fd_prestat_dir_name') return () => 8;
      if (name === 'environ_sizes_get') return (count, size) => {
        const dv = new DataView(memory.buffer);
        dv.setUint32(count, 0, true);
        dv.setUint32(size, 0, true);
        return 0;
      };
      if (name === 'environ_get') return () => 0;
      if (name === 'args_sizes_get') return (argc, size) => {
        const dv = new DataView(memory.buffer);
        dv.setUint32(argc, 0, true);
        dv.setUint32(size, 0, true);
        return 0;
      };
      if (name === 'args_get') return () => 0;
      if (name === 'clock_time_get') return () => 0;
      if (name === 'random_get') return (buf, len) => {
        const view = new Uint8Array(memory.buffer, buf, len);
        for (let i = 0; i < len; i++) view[i] = (Math.random() * 256) | 0;
        return 0;
      };
      // Default WASI stub
      return () => 0;
    }

    // Fallback no-op
    return () => 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : outL;
    const blockSize = outL.length;

    if (!this.ready || !this.wasmInstance) {
      // Silence
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      return true;
    }

    try {
      const exports = this.wasmInstance.exports;

      if (exports.processBlock) {
        // Preferred: block-based processing
        // Allocate temp buffers in WASM memory
        const memory = exports.memory || this.wasmInstance.exports.__indirect_function_table;
        const bufferL = exports.getOutputBufferL ? exports.getOutputBufferL() : 0;
        const bufferR = exports.getOutputBufferR ? exports.getOutputBufferR() : 0;

        exports.processBlock(blockSize);

        if (bufferL && exports.memory) {
          const wasmMem = new Float32Array(exports.memory.buffer);
          const offsetL = bufferL / 4;
          const offsetR = bufferR / 4;
          for (let i = 0; i < blockSize; i++) {
            outL[i] = wasmMem[offsetL + i];
            outR[i] = wasmMem[offsetR + i];
          }
        }
      } else if (exports.processSample) {
        // Sample-by-sample fallback
        for (let i = 0; i < blockSize; i++) {
          const sample = exports.processSample();
          outL[i] = sample;
          outR[i] = sample;
        }
      } else {
        outL.fill(0);
        if (outR !== outL) outR.fill(0);
      }
    } catch (err) {
      outL.fill(0);
      if (outR !== outL) outR.fill(0);
      this.port.postMessage({ type: 'error', message: err.message });
    }

    // Compute RMS for VU meter (send every ~10 frames to avoid flooding)
    this.frameCount++;
    if (this.frameCount % 10 === 0) {
      let sum = 0;
      for (let i = 0; i < outL.length; i++) {
        sum += outL[i] * outL[i];
      }
      this.rmsLevel = Math.sqrt(sum / outL.length);
      this.port.postMessage({ type: 'rms', level: this.rmsLevel });
    }

    return true;
  }
}

registerProcessor('daisy-processor', DaisyProcessor);
