# daisy-gpt

AI synth patch generator for Daisy Patch. Describe a patch, get C++ code, compile and play it in the browser.

**Live:** [bradbrok.github.io/BrokModular-DaisyGPT](https://bradbrok.github.io/BrokModular-DaisyGPT/)

## How it works

1. Chat with an LLM (Anthropic, OpenAI, OpenRouter) to generate Daisy Patch C++ code
2. In-browser clang (via [binji/wasm-clang](https://github.com/binji/wasm-clang)) compiles C++ to WASM
3. AudioWorklet runs the compiled WASM for real-time audio playback
4. Knobs, gates, MIDI — all controllable from the browser UI

## TODO

- [ ] **ARM cross-compile server** — Add a backend compile endpoint (`POST /compile`) with `arm-none-eabi-gcc` + libDaisy SDK that returns a `.bin` file. Browser sends C++ code, server compiles for STM32 ARM Cortex-M7, returns binary for DFU flash. The WebUSB DFU flashing (`dfu.js`) is already implemented.
