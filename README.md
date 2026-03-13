# daisy-gpt

AI synth patch generator for the Electro-Smith Daisy platform. Describe a synth patch in plain language, get compilable C++ code, preview it in real-time audio, and flash it to real hardware — all from the browser.

**Live:** [bradbrok.github.io/BrokModular-DaisyGPT](https://bradbrok.github.io/BrokModular-DaisyGPT/)

## How It Works

1. **Describe** a patch in the chat (e.g. "acid bassline with resonant filter and portamento")
2. **Generate** — an LLM writes complete Daisy Patch C++ code
3. **Preview** — in-browser clang compiles to WASM, AudioWorklet plays it at 48kHz
4. **Flash** — remote ARM cross-compilation produces a `.bin`, WebUSB DFU flashes it to your Daisy Seed

No installs, no toolchain setup, no build steps. Pure browser.

## Features

### AI Chat
- **Multi-provider:** Anthropic (Claude Opus/Sonnet/Haiku 4.x), OpenAI (GPT-5.4, GPT-5 Mini, o3, o4-mini), OpenRouter (7 models), Ollama (local, any model)
- **Extended thinking / reasoning** with configurable token budgets and effort levels
- **15 skill templates:** acid bassline, ambient reverb, CV processor, delay, distortion, drum machine, filter FX, FM synthesis, generative, granular, LFO modulation, MIDI-to-CV, physical modeling, subtractive synth, wavetable synth
- Streaming responses, full chat history, undo last code change

### Code Editor
- Syntax-highlighted C++ editor (highlight.js) with line/column tracking
- Browse DaisySP and system headers from the compiler's virtual filesystem
- Download `.cpp` files

### Compilation
- **In-browser WASM:** [binji/wasm-clang](https://github.com/binji/wasm-clang) (~60MB, cached by Service Worker after first load)
- **Remote ARM:** Dockerized `gcc-arm-none-eabi` + libDaisy v7.0.1 + DaisySP, produces real `.bin` firmware
- **Auto-retry:** on compile errors, the LLM reads the error output and fixes the code (up to 3 attempts)

### Audio
- Real-time AudioWorklet playback at 48kHz stereo
- **Audio input:** microphone/line-in device selection, or load a sample file with loop/transport controls
- **Audio output:** device selector (headphones, speakers, etc.)
- **Diagnostics:** oscilloscope, FFT spectrum analyzer, stereo level meters with peak hold, clipping indicators, RMS/peak/latency stats

### Hardware Controls
- 4 knobs (0.0–1.0) + 2 gate buttons in the browser UI
- **MIDI:** Web MIDI API with device selection, note/CV/velocity/pitch bend readout, CC-to-knob mapping per channel
- **Computer keyboard:** Z–M = white keys, S/D/G/H/J = black keys (C4 octave)

### Flashing
- **WebUSB DFU** flash to Daisy Seed (STM32H750) — Chrome/Edge only
- Click "Compile for Daisy" then "Flash to Daisy" — progress bar and log output
- Supports flash (0x08000000) and QSPI (0x90040000) boot targets

## Quick Start

1. Open [the live app](https://bradbrok.github.io/BrokModular-DaisyGPT/) in **Chrome** or **Edge**
2. Click the gear icon, enter an API key for any supported provider, and save
3. Type a patch description in the chat — code generates, compiles, and you can hit **Play**
4. Tweak with knobs, connect MIDI, adjust parameters through conversation
5. To flash real hardware: click **Compile for Daisy** → put Daisy in DFU mode (hold BOOT, tap RESET) → click **Flash to Daisy**

## Architecture

```
 User prompt
      |
      v
 LLM (Anthropic / OpenAI / OpenRouter / Ollama)
      |
      v
 C++ code (patch.cpp)
      |
      +---> In-browser clang ---> WASM ---> AudioWorklet (preview)
      |
      +---> Remote ARM server ---> .bin ---> WebUSB DFU (hardware)
```

**Tech stack:** Vanilla JavaScript (no framework, no build step), Web Audio API, WebUSB, Web MIDI API, Service Worker.

**Client:** `index.html` + `app.js` + `style.css` — served as static files from GitHub Pages.

**Server:** Python/Flask in Docker with Caddy reverse proxy for auto-TLS.

## Self-Hosting the Compile Server

The public compile server at `compile.brokmodular.com` is used by default. To run your own:

```bash
cd server
docker compose up -d --build
```

Point a DNS A record to your server's IP. Caddy handles TLS automatically via Let's Encrypt.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | Flask listen port |
| `MAX_CONCURRENT` | `5` | Max simultaneous compilations |
| `MAX_PENDING` | `10` | Max queued compilations |
| `COMPILE_TIMEOUT` | `60` | Seconds before a build is killed |
| `ALLOWED_ORIGINS` | `https://bradbrok.github.io` | CORS allowed origins (comma-separated) |

### Security

- Runs as non-root `daisy` user inside the container
- `no-new-privileges`, all Linux capabilities dropped
- Resource limits: 512MB RAM, 2 CPUs, 100 PIDs, 256MB tmpfs
- **Include allowlist:** only Daisy, DaisySP, and standard embedded C/C++ headers are permitted — everything else is rejected before compilation
- Rate limited: 10 compilations per IP per 15 minutes
- Internal paths stripped from error output

### API

**`POST /compile`**

Request:
```json
{ "code": "#include \"daisy_seed.h\"\n...", "target": "flash" }
```
`target` is `"flash"` (0x08000000) or `"qspi"` (0x90040000). Defaults to `"flash"`.

Success: `200` with `application/octet-stream` body (the `.bin` file) and headers:
- `X-Compile-Time` — seconds
- `X-Binary-Size` — bytes
- `X-Target-Address` — hex address

Error: `422` with `{ "error": "compilation_failed", "stderr": "...", "exit_code": 1 }`

**`GET /health`**
```json
{ "status": "ok", "queue": { "active": 0, "pending": 0, "max_concurrent": 5, "max_pending": 10 } }
```

## Project Structure

```
├── index.html              # UI layout
├── app.js                  # Main application (2700 lines)
├── style.css               # Black & gold mono theme
├── providers.js            # LLM provider integrations
├── compiler.js             # In-browser WASM C++ compiler
├── dfu.js                  # WebUSB DFU flashing
├── midi.js                 # Web MIDI controller
├── worklet-processor.js    # AudioWorklet DSP runner
├── sw.js                   # Service Worker (compiler caching)
├── skills/                 # 15 AI prompt skill templates
│   └── index.js
├── reference/              # DaisySP API reference data
│   └── daisysp_ref.js
└── server/                 # Remote ARM compilation server
    ├── Dockerfile          # Multi-stage: build libDaisy/DaisySP, then runtime
    ├── docker-compose.yml  # Resource limits, security, Caddy sidecar
    ├── Caddyfile           # Auto-TLS reverse proxy
    ├── app.py              # Flask application
    ├── requirements.txt    # flask, flask-cors, flask-limiter, gunicorn
    ├── routes/
    │   ├── compile.py      # POST /compile
    │   └── health.py       # GET /health
    ├── services/
    │   ├── compiler.py     # ARM build orchestration
    │   ├── queue.py        # Concurrency limiter (semaphore)
    │   └── sanitize.py     # Include allowlist
    ├── middleware/
    │   ├── rate_limit.py   # Per-IP rate limiting
    │   └── validate.py     # Request validation
    └── template/
        └── Makefile        # ARM cross-compilation template
```

## Requirements

- **Browser:** Chrome or Edge (WebUSB, Web MIDI, AudioWorklet)
- **API key:** Anthropic, OpenAI, or OpenRouter — or a local [Ollama](https://ollama.com) instance (no key needed)
- **Hardware (optional):** Electro-Smith Daisy Seed for flashing

## License

MIT
