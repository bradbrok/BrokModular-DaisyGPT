// compiler.js — In-browser C++ → WASM compiler for daisy-gpt
// Adapts binji/wasm-clang for compiling Daisy Patch code to WebAssembly
//
// Architecture:
//   1. Lazy-loads clang, lld, memfs, sysroot from binji.github.io CDN (~60MB)
//   2. Sets up VFS with DaisySP header-only library
//   3. Wraps user C++ code with extern "C" export glue
//   4. Compiles (clang -cc1) and links (wasm-ld) to produce WASM bytes
//
// Inlines portions of shared.js from binji/wasm-clang (Apache 2.0 License)
// https://github.com/binji/wasm-clang

import { DAISYSP_HEADERS } from './stubs/daisysp_browser.js';

const CDN = 'https://binji.github.io/wasm-clang/';

// ─── Wrapper Code ────────────────────────────────────────────────────
// Prepended to user code: defines the global state variables

const WRAPPER_PREFIX = `\
extern "C" {
  float daisy_knob[8] = {0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f, 0.5f};
  bool  daisy_gate[2] = {false, false};
  bool  daisy_gate_out[2] = {false, false};
  float daisy_sample_rate = 48000.0f;
  float daisy_pitch_cv = 0.0f;
  float daisy_velocity = 0.0f;
  float daisy_pitchbend = 0.0f;
  float daisy_cv_in[4] = {0.0f, 0.0f, 0.0f, 0.0f};
  float daisy_cv_out[2] = {0.0f, 0.0f};
}
`;

// Appended to user code: provides extern "C" exports for AudioWorklet
const WRAPPER_SUFFIX = `\

static float _wbuf_in[4][256]  = {};
static const float* _wbuf_inPtrs[4]  = {_wbuf_in[0], _wbuf_in[1], _wbuf_in[2], _wbuf_in[3]};
static float _wbuf_out[4][256] = {};
static float* _wbuf_outPtrs[4] = {_wbuf_out[0], _wbuf_out[1], _wbuf_out[2], _wbuf_out[3]};

extern "C" {

void init(float sr) {
    daisy_sample_rate = sr;
    main();
}

float processSample() {
    for (int i = 0; i < 4; i++) _wbuf_out[i][0] = 0.0f;
    AudioCallback(
        (daisy::AudioHandle::InputBuffer)_wbuf_inPtrs,
        (daisy::AudioHandle::OutputBuffer)_wbuf_outPtrs,
        1
    );
    return _wbuf_out[0][0];
}

void setInputSample(float left, float right) {
    _wbuf_in[0][0] = left;
    _wbuf_in[1][0] = right;
}

float* getInputBufferL()  { return _wbuf_in[0]; }
float* getInputBufferR()  { return _wbuf_in[1]; }
float* getOutputBufferL() { return _wbuf_out[0]; }
float* getOutputBufferR() { return _wbuf_out[1]; }

void processBlock(int size) {
    for (int i = 0; i < 4; i++)
        for (int j = 0; j < size; j++) _wbuf_out[i][j] = 0.0f;
    AudioCallback(
        (daisy::AudioHandle::InputBuffer)_wbuf_inPtrs,
        (daisy::AudioHandle::OutputBuffer)_wbuf_outPtrs,
        size
    );
}

void setKnob(int index, float value) {
    if (index >= 0 && index < 8) daisy_knob[index] = value;
}

void setGate(int index, int value) {
    if (index >= 0 && index < 2) daisy_gate[index] = (value != 0);
}

void setCvIn(int index, float value) {
    if (index >= 0 && index < 4) daisy_cv_in[index] = value;
}

void setPitchCV(float cv) { daisy_pitch_cv = cv; }
void setVelocity(float vel) { daisy_velocity = vel; }
void setPitchBend(float pb) { daisy_pitchbend = pb; }

} // extern "C"
`;

const WRAPPER_PREFIX_LINES = WRAPPER_PREFIX.split('\n').length;

// ─── Inlined binji/wasm-clang core (Apache 2.0) ─────────────────────
// Pruned: removed Canvas API, 6502, assembly output, demo-specific code.

function readStr(u8, o, len = -1) {
  let str = '';
  let end = u8.length;
  if (len !== -1) end = o + len;
  for (let i = o; i < end && u8[i] !== 0; ++i)
    str += String.fromCharCode(u8[i]);
  return str;
}

function getImportObject(obj, names) {
  const result = {};
  for (const name of names) result[name] = obj[name].bind(obj);
  return result;
}

function msToSec(start, end) {
  return ((end - start) / 1000).toFixed(2);
}

const ESUCCESS = 0;

class ProcExit extends Error {
  constructor(code) { super(`process exited with code ${code}.`); this.code = code; }
}

class AbortError extends Error {
  constructor(msg = 'abort') { super(msg); }
}

function assert(cond) {
  if (!cond) throw new Error('assertion failed.');
}

// Memory wrapper — handles detached ArrayBuffer after WASM memory.grow
class Memory {
  constructor(memory) {
    this.memory = memory;
    this.buffer = memory.buffer;
    this.u8 = new Uint8Array(this.buffer);
    this.u32 = new Uint32Array(this.buffer);
  }

  check() {
    if (this.buffer.byteLength === 0) {
      this.buffer = this.memory.buffer;
      this.u8 = new Uint8Array(this.buffer);
      this.u32 = new Uint32Array(this.buffer);
    }
  }

  read8(o)  { return this.u8[o]; }
  read32(o) { return this.u32[o >> 2]; }
  write8(o, v)  { this.u8[o] = v; }
  write32(o, v) { this.u32[o >> 2] = v; }
  write64(o, vlo, vhi = 0) { this.write32(o, vlo); this.write32(o + 4, vhi); }

  readStr(o, len) { return readStr(this.u8, o, len); }

  writeStr(o, str) {
    o += this.write(o, str);
    this.write8(o, 0);
    return str.length + 1;
  }

  write(o, buf) {
    if (buf instanceof ArrayBuffer) return this.write(o, new Uint8Array(buf));
    if (typeof buf === 'string') return this.write(o, buf.split('').map(x => x.charCodeAt(0)));
    const dst = new Uint8Array(this.buffer, o, buf.length);
    dst.set(buf);
    return buf.length;
  }
}

// MemFS — in-memory filesystem backed by memfs.wasm
class MemFS {
  constructor(options) {
    const compileStreaming = options.compileStreaming;
    this.hostWrite = options.hostWrite;
    this.stdinStr = options.stdinStr || '';
    this.stdinStrPos = 0;
    this.memfsFilename = options.memfsFilename;
    this.hostMem_ = null;

    const env = getImportObject(this, ['abort', 'host_write', 'host_read', 'memfs_log', 'copy_in', 'copy_out']);

    this.ready = compileStreaming(this.memfsFilename)
      .then(module => WebAssembly.instantiate(module, { env }))
      .then(instance => {
        this.instance = instance;
        this.exports = instance.exports;
        this.mem = new Memory(this.exports.memory);
        this.exports.init();
      });
  }

  set hostMem(mem) { this.hostMem_ = mem; }

  setStdinStr(str) { this.stdinStr = str; this.stdinStrPos = 0; }

  addDirectory(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    this.exports.AddDirectoryNode(path.length);
  }

  addFile(path, contents) {
    const length = contents instanceof ArrayBuffer ? contents.byteLength : contents.length;
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.AddFileNode(path.length, length);
    const addr = this.exports.GetFileNodeAddress(inode);
    this.mem.check();
    this.mem.write(addr, contents);
  }

  getFileContents(path) {
    this.mem.check();
    this.mem.write(this.exports.GetPathBuf(), path);
    const inode = this.exports.FindNode(path.length);
    const addr = this.exports.GetFileNodeAddress(inode);
    const size = this.exports.GetFileNodeSize(inode);
    return new Uint8Array(this.mem.buffer, addr, size);
  }

  abort() { throw new AbortError(); }

  host_write(fd, iovs, iovs_len, nwritten_out) {
    this.hostMem_.check();
    assert(fd <= 2);
    let size = 0;
    let str = '';
    for (let i = 0; i < iovs_len; ++i) {
      const buf = this.hostMem_.read32(iovs); iovs += 4;
      const len = this.hostMem_.read32(iovs); iovs += 4;
      str += this.hostMem_.readStr(buf, len);
      size += len;
    }
    this.hostMem_.write32(nwritten_out, size);
    this.hostWrite(str);
    return ESUCCESS;
  }

  host_read(fd, iovs, iovs_len, nread) {
    this.hostMem_.check();
    assert(fd === 0);
    let size = 0;
    for (let i = 0; i < iovs_len; ++i) {
      const buf = this.hostMem_.read32(iovs); iovs += 4;
      const len = this.hostMem_.read32(iovs); iovs += 4;
      const toWrite = Math.min(len, this.stdinStr.length - this.stdinStrPos);
      if (toWrite === 0) break;
      this.hostMem_.write(buf, this.stdinStr.substr(this.stdinStrPos, toWrite));
      size += toWrite;
      this.stdinStrPos += toWrite;
      if (toWrite !== len) break;
    }
    this.hostMem_.write32(nread, size);
    return ESUCCESS;
  }

  memfs_log(buf, len) {
    this.mem.check();
    console.log(this.mem.readStr(buf, len));
  }

  copy_out(clang_dst, memfs_src, size) {
    this.hostMem_.check();
    const dst = new Uint8Array(this.hostMem_.buffer, clang_dst, size);
    this.mem.check();
    const src = new Uint8Array(this.mem.buffer, memfs_src, size);
    dst.set(src);
  }

  copy_in(memfs_dst, clang_src, size) {
    this.mem.check();
    const dst = new Uint8Array(this.mem.buffer, memfs_dst, size);
    this.hostMem_.check();
    const src = new Uint8Array(this.hostMem_.buffer, clang_src, size);
    dst.set(src);
  }
}

// Tar — unpacks sysroot.tar into MemFS
class Tar {
  constructor(buffer) {
    this.u8 = new Uint8Array(buffer);
    this.offset = 0;
  }

  readStr(len) {
    const result = readStr(this.u8, this.offset, len);
    this.offset += len;
    return result;
  }

  readOctal(len) { return parseInt(this.readStr(len), 8); }
  alignUp()      { this.offset = (this.offset + 511) & ~511; }

  readEntry() {
    if (this.offset + 512 > this.u8.length) return null;
    const entry = {
      filename: this.readStr(100),
      mode:     this.readOctal(8),
      owner:    this.readOctal(8),
      group:    this.readOctal(8),
      size:     this.readOctal(12),
      mtim:     this.readOctal(12),
      checksum: this.readOctal(8),
      type:     this.readStr(1),
      linkname: this.readStr(100),
    };
    if (this.readStr(8) !== 'ustar  ') return null;
    entry.ownerName = this.readStr(32);
    entry.groupName = this.readStr(32);
    entry.devMajor = this.readStr(8);
    entry.devMinor = this.readStr(8);
    entry.filenamePrefix = this.readStr(155);
    this.alignUp();

    if (entry.type === '0') {
      entry.contents = this.u8.subarray(this.offset, this.offset + entry.size);
      this.offset += entry.size;
      this.alignUp();
    } else if (entry.type !== '5') {
      assert(false);
    }
    return entry;
  }

  untar(memfs) {
    let entry;
    while ((entry = this.readEntry())) {
      if (entry.type === '0') memfs.addFile(entry.filename, entry.contents);
      else if (entry.type === '5') memfs.addDirectory(entry.filename);
    }
  }
}

// App — runs a WASM application (clang/lld) with WASI + memfs
class App {
  constructor(module, memfs, name, ...args) {
    this.argv = [name, ...args];
    this.environ = { USER: 'alice' };
    this.memfs = memfs;

    // Canvas stubs — clang/lld may import these (no-op)
    const canvasStubs = {};
    const canvasNames = [
      'canvas_arc','canvas_arcTo','canvas_beginPath','canvas_bezierCurveTo',
      'canvas_clearRect','canvas_clip','canvas_closePath','canvas_createImageData',
      'canvas_destroyHandle','canvas_ellipse','canvas_fill','canvas_fillRect',
      'canvas_fillText','canvas_imageDataSetData','canvas_lineTo','canvas_measureText',
      'canvas_moveTo','canvas_putImageData','canvas_quadraticCurveTo','canvas_rect',
      'canvas_requestAnimationFrame','canvas_restore','canvas_rotate','canvas_save',
      'canvas_scale','canvas_setFillStyle','canvas_setFont','canvas_setGlobalAlpha',
      'canvas_setHeight','canvas_setLineCap','canvas_setLineDashOffset',
      'canvas_setLineJoin','canvas_setLineWidth','canvas_setMiterLimit',
      'canvas_setShadowBlur','canvas_setShadowColor','canvas_setShadowOffsetX',
      'canvas_setShadowOffsetY','canvas_setStrokeStyle','canvas_setTextAlign',
      'canvas_setTextBaseline','canvas_setTransform','canvas_setWidth',
      'canvas_stroke','canvas_strokeRect','canvas_strokeText','canvas_transform',
      'canvas_translate',
    ];
    for (const n of canvasNames) canvasStubs[n] = () => 0;

    const wasi_unstable = getImportObject(this, [
      'proc_exit', 'environ_sizes_get', 'environ_get',
      'args_sizes_get', 'args_get', 'random_get',
      'clock_time_get', 'poll_oneoff',
    ]);

    // Filesystem operations from memfs
    Object.assign(wasi_unstable, this.memfs.exports);

    this.ready = WebAssembly.instantiate(module, { wasi_unstable, env: canvasStubs })
      .then(instance => {
        this.instance = instance;
        this.exports = instance.exports;
        this.mem = new Memory(this.exports.memory);
        this.memfs.hostMem = this.mem;
      });
  }

  async run() {
    await this.ready;
    try {
      this.exports._start();
    } catch (exn) {
      if (exn instanceof ProcExit) {
        if (exn.code === 0) return false;
      }
      this.memfs.hostWrite(`Error: ${exn.message}\n`);
      throw exn;
    }
    return false;
  }

  proc_exit(code) { throw new ProcExit(code); }

  environ_sizes_get(count_out, size_out) {
    this.mem.check();
    const names = Object.getOwnPropertyNames(this.environ);
    let size = 0;
    for (const name of names) size += name.length + this.environ[name].length + 2;
    this.mem.write64(count_out, names.length);
    this.mem.write64(size_out, size);
    return ESUCCESS;
  }

  environ_get(ptrs, buf) {
    this.mem.check();
    for (const name of Object.getOwnPropertyNames(this.environ)) {
      this.mem.write32(ptrs, buf);
      ptrs += 4;
      buf += this.mem.writeStr(buf, `${name}=${this.environ[name]}`);
    }
    this.mem.write32(ptrs, 0);
    return ESUCCESS;
  }

  args_sizes_get(argc_out, argv_size_out) {
    this.mem.check();
    let size = 0;
    for (const arg of this.argv) size += arg.length + 1;
    this.mem.write64(argc_out, this.argv.length);
    this.mem.write64(argv_size_out, size);
    return ESUCCESS;
  }

  args_get(ptrs, buf) {
    this.mem.check();
    for (const arg of this.argv) {
      this.mem.write32(ptrs, buf);
      ptrs += 4;
      buf += this.mem.writeStr(buf, arg);
    }
    this.mem.write32(ptrs, 0);
    return ESUCCESS;
  }

  random_get(buf, len) {
    const data = new Uint8Array(this.mem.buffer, buf, len);
    for (let i = 0; i < len; ++i) data[i] = (Math.random() * 256) | 0;
  }

  clock_time_get() { return 0; }
  poll_oneoff()    { return 0; }
}

// ─── DaisyClangAPI — modified compile/link for Daisy patches ─────────

class DaisyClangAPI {
  constructor(options) {
    this.moduleCache = {};
    this.readBuffer = options.readBuffer;
    this.compileStreaming = options.compileStreaming;
    this.hostWrite = options.hostWrite;
    this.clangFilename = options.clang || 'clang';
    this.lldFilename = options.lld || 'lld';
    this.sysrootFilename = options.sysroot || 'sysroot.tar';
    this.showTiming = false;

    this.clangCommonArgs = [
      '-disable-free',
      '-isysroot', '/',
      '-internal-isystem', '/include/c++/v1',
      '-internal-isystem', '/include',
      '-internal-isystem', '/lib/clang/8.0.1/include',
      '-ferror-limit', '19',
      '-fmessage-length', '80',
      '-fcolor-diagnostics',
    ];

    this.memfs = new MemFS({
      compileStreaming: this.compileStreaming,
      hostWrite: this.hostWrite,
      memfsFilename: options.memfs || 'memfs',
    });

    this.ready = this.memfs.ready.then(() => this._untar(this.sysrootFilename));
  }

  async _untar(filename) {
    const buffer = await this.readBuffer(filename);
    const tar = new Tar(buffer);
    tar.untar(this.memfs);
  }

  async getModule(name) {
    if (this.moduleCache[name]) return this.moduleCache[name];
    const module = await this.compileStreaming(name);
    this.moduleCache[name] = module;
    return module;
  }

  async _run(module, ...args) {
    const app = new App(module, this.memfs, ...args);
    await app.run();
  }

  // Compile C++ source to object file — modified for Daisy
  async compile(options) {
    const { input, contents, obj } = options;
    await this.ready;
    this.memfs.addFile(input, contents);
    const clang = await this.getModule(this.clangFilename);
    return await this._run(clang, 'clang', '-cc1', '-emit-obj',
      ...this.clangCommonArgs,
      '-std=c++17',
      '-O2',
      '-o', obj, '-x', 'c++', input);
  }

  // Link object file to WASM — modified for Daisy (no-entry, export-dynamic)
  async link(obj, wasm) {
    const libdir = 'lib/wasm32-wasi';
    await this.ready;
    const lld = await this.getModule(this.lldFilename);
    return await this._run(
      lld, 'wasm-ld',
      '--no-threads',
      '--no-entry',
      '--export-dynamic',
      '--allow-undefined',
      `-L${libdir}`,
      obj,
      '-lc', '-lc++', '-lc++abi',
      '-o', wasm);
  }
}

// ─── WasmClangCompiler — public API ──────────────────────────────────

export class WasmClangCompiler {
  constructor() {
    this.api = null;
    this.ready = false;
    this._loading = null;
  }

  get loaded() { return this.ready; }

  // Expose DaisySP headers for file browser
  getHeaders() { return DAISYSP_HEADERS; }

  // Lazy-load compiler toolchain (~60MB, cached by ServiceWorker)
  async load(onProgress) {
    if (this.ready) return;
    if (this._loading) return this._loading;

    this._loading = this._doLoad(onProgress);
    try {
      await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async _doLoad(onProgress) {
    const report = (msg) => {
      onProgress?.(msg);
      console.log(`[compiler] ${msg}`);
    };

    report('Loading compiler (60MB, first time only)...');

    this.api = new DaisyClangAPI({
      async readBuffer(filename) {
        report(`Fetching ${filename}...`);
        const resp = await fetch(CDN + filename);
        if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`);
        // Content-Length from CDN can be wrong/missing — use fallback for sysroot.tar (~9.3MB)
        const SYSROOT_EXPECTED_SIZE = 9_750_000;
        let total = parseInt(resp.headers.get('content-length') || '0', 10);
        if (!total && filename === 'sysroot.tar') total = SYSROOT_EXPECTED_SIZE;
        if (!total || !resp.body) return resp.arrayBuffer();

        // Stream with progress
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total > 0) {
            const pct = Math.min(100, Math.round((received / total) * 100));
            report(`Fetching ${filename}... ${pct}%`);
          }
        }
        const result = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }
        return result.buffer;
      },

      async compileStreaming(filename) {
        report(`Loading ${filename}...`);
        const resp = await fetch(CDN + filename);
        if (!resp.ok) throw new Error(`Failed to fetch ${filename}: ${resp.status}`);
        return WebAssembly.compile(await resp.arrayBuffer());
      },

      hostWrite(s) {
        // Captured per-compilation; default logs to console
        console.log('[clang]', s);
      },
    });

    report('Unpacking sysroot...');
    await this.api.ready;

    report('Setting up DaisySP headers...');
    this._setupHeaders();

    this.ready = true;
    report('Compiler ready');
  }

  _setupHeaders() {
    // Place DaisySP headers under include/ which already exists from sysroot.
    // Creating a new root-level dir (daisysp/) would trigger a memfs assertion.
    const dirs = new Set();
    for (const [path] of DAISYSP_HEADERS) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        dirs.add('include/' + parts.slice(0, i).join('/'));
      }
    }
    // Create subdirectories (include/ already exists from sysroot)
    for (const dir of [...dirs].sort()) {
      this.api.memfs.addDirectory(dir);
    }
    // Add header files
    for (const [path, contents] of DAISYSP_HEADERS) {
      this.api.memfs.addFile(`include/${path}`, contents);
    }
  }

  // Strip infinite loop at end of main() so it returns
  // Uses brace-counting to handle nested braces (e.g., display update loops)
  _stripInfiniteLoop(code) {
    const pattern = /\b(?:while\s*\(\s*(?:1|true)\s*\)|for\s*\(\s*;?\s*;?\s*\))\s*\{/g;
    let result = code;
    let match;
    // Process from end to start so replacements don't shift earlier indices
    const matches = [];
    while ((match = pattern.exec(result)) !== null) {
      matches.push({ index: match.index, length: match[0].length });
    }
    for (let m = matches.length - 1; m >= 0; m--) {
      const { index, length } = matches[m];
      const braceStart = index + length - 1; // position of opening {
      let depth = 1;
      let i = braceStart + 1;
      while (i < result.length && depth > 0) {
        if (result[i] === '{') depth++;
        else if (result[i] === '}') depth--;
        i++;
      }
      if (depth === 0) {
        result = result.slice(0, index) + '/* loop stripped */' + result.slice(i);
      }
    }
    return result;
  }

  // Wrap user code with prefix (global defs) and suffix (export functions)
  _wrapCode(userCode) {
    const stripped = this._stripInfiniteLoop(userCode);
    return WRAPPER_PREFIX + '\n' + stripped + '\n' + WRAPPER_SUFFIX;
  }

  // Adjust error line numbers to account for wrapper prefix
  _adjustErrors(errorText) {
    return errorText.replace(
      /patch\.cpp:(\d+)/g,
      (match, lineStr) => {
        const adjusted = parseInt(lineStr, 10) - WRAPPER_PREFIX_LINES;
        return `line ${adjusted}`;
      }
    );
  }

  // Compile C++ code to WASM bytes
  async compile(userCode) {
    if (!this.ready) throw new Error('Compiler not loaded. Call load() first.');

    let output = '';
    const origWrite = this.api.hostWrite;
    this.api.memfs.hostWrite = (s) => { output += s; };

    try {
      const wrapped = this._wrapCode(userCode);

      // Compile C++ → .o (flat paths — memfs has no /tmp/ directory)
      await this.api.compile({
        input: 'patch.cpp',
        contents: wrapped,
        obj: 'patch.o',
      });

      // Link .o → .wasm
      await this.api.link('patch.o', 'patch.wasm');

      // Read output WASM
      const wasmBytes = this.api.memfs.getFileContents('patch.wasm');
      return new Uint8Array(wasmBytes);

    } catch (err) {
      // ProcExit with code 1 means compilation error
      if (err instanceof ProcExit && err.code === 1) {
        throw new Error(this._adjustErrors(output) || 'Compilation failed');
      }
      throw new Error(this._adjustErrors(output) || err.message);
    } finally {
      this.api.memfs.hostWrite = origWrite;
    }
  }
}
