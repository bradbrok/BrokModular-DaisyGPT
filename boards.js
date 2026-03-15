// Board definitions for all Daisy platforms
// Each board defines its hardware I/O, class name, header, and system prompt fragment.

export const BOARDS = {
  seed: {
    id: 'seed',
    name: 'Daisy Seed',
    className: 'DaisySeed',
    header: 'daisy_seed.h',
    description: 'Raw Daisy Seed module — maximum flexibility, define your own I/O',
    knobs: 0,
    gates: 0,
    cvOutputs: 0,
    hasOLED: false,
    hasMidi: true,
    audioChannels: { in: 2, out: 2 },
    gpioCount: 31,
    adcPins: ['A0','A1','A2','A3','A4','A5','A6','A7','A8','A9','A10','A11'],
    promptFragment: `You are programming a Daisy Seed — the raw module with no built-in UI.

Hardware:
- Global object: \`DaisySeed seed;\`
- Init: \`seed.Init();\` then \`seed.SetAudioBlockSize(48);\` and \`seed.StartAudio(AudioCallback);\`
- Audio callback: \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
- ADC (analog inputs): Up to 12 ADC channels on pins A0-A11. Configure with \`AdcChannelConfig adc[N]; adc[0].InitSingle(seed.GetPin(15)); seed.adc.Init(adc, N); seed.adc.Start();\`
- Read ADC: \`seed.adc.GetFloat(channel)\` returns 0.0-1.0
- GPIO: 31 digital pins available for buttons, LEDs, encoders
- No built-in knobs, display, or gates — all I/O is user-defined
- DAC outputs available on pins A4, A5 for CV out

When generating code:
1. Include "daisy_seed.h" and "daisysp.h"
2. Use \`using namespace daisy; using namespace daisysp;\`
3. Declare \`DaisySeed seed;\` as global
4. Configure any ADC/GPIO pins the user needs
5. Comment which physical pins are used for each function`,
    template: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed seed;

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
    for (size_t i = 0; i < size; i++) {
        out[0][i] = in[0][i];
        out[1][i] = in[1][i];
    }
}

int main(void) {
    seed.Init();
    seed.SetAudioBlockSize(48);
    seed.StartAudio(AudioCallback);
    while(1) {}
}
`,
  },

  patch: {
    id: 'patch',
    name: 'Daisy Patch',
    className: 'DaisyPatch',
    header: 'daisy_patch.h',
    description: '4 knobs, 2 gate inputs, 4 CV inputs, OLED display, 4-channel audio',
    knobs: 4,
    gates: 2,
    cvOutputs: 2,
    hasOLED: true,
    hasMidi: true,
    audioChannels: { in: 4, out: 4 },
    knobNames: ['CTRL_1', 'CTRL_2', 'CTRL_3', 'CTRL_4'],
    promptFragment: `You are programming a Daisy Patch — a 4-voice Eurorack module.

Hardware:
- Global object: \`DaisyPatch patch;\`
- Init: \`patch.Init();\` then \`patch.StartAudio(AudioCallback);\`
- Audio callback: \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
- 4 knobs: \`patch.GetKnobValue(DaisyPatch::CTRL_1)\` through CTRL_4 (returns 0.0-1.0)
- 2 gate inputs: \`patch.gate_input[0].Trig()\` and \`patch.gate_input[1].Trig()\`
- 4 CV inputs on the audio jacks
- 2 CV outputs: \`patch.seed.dac.WriteValue(DacHandle::Channel::ONE, value)\`
- 128x64 OLED: \`patch.display.Fill(false); patch.display.SetCursor(0,0); patch.display.WriteString("text", Font_7x10, true); patch.display.Update();\`

CRITICAL — KNOB LABELS: Add a short \`// Label\` comment at the end of EVERY line that reads CTRL_N:
\`float freq = fmap(patch.GetKnobValue(DaisyPatch::CTRL_1), 20.f, 2000.f, Mapping::LOG); // Frequency\`

Use \`fmap()\` for knob scaling (with Mapping::LOG for frequency-like params).`,
    template: `#include "daisy_patch.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisyPatch patch;
Oscillator osc;

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
    patch.ProcessAllControls();
    float freq = fmap(patch.GetKnobValue(DaisyPatch::CTRL_1), 20.f, 2000.f, Mapping::LOG); // Frequency
    float amp = patch.GetKnobValue(DaisyPatch::CTRL_2); // Volume
    osc.SetFreq(freq);
    osc.SetAmp(amp);
    for (size_t i = 0; i < size; i++) {
        float sig = osc.Process();
        out[0][i] = sig;
        out[1][i] = sig;
        out[2][i] = 0.f;
        out[3][i] = 0.f;
    }
}

int main(void) {
    patch.Init();
    osc.Init(patch.AudioSampleRate());
    osc.SetWaveform(Oscillator::WAVE_SAW);
    patch.StartAudio(AudioCallback);
    while(1) {
        patch.DisplayControls(false);
    }
}
`,
  },

  pod: {
    id: 'pod',
    name: 'Daisy Pod',
    className: 'DaisyPod',
    header: 'daisy_pod.h',
    description: '2 knobs, 2 buttons, 2 RGB LEDs, stereo audio',
    knobs: 2,
    gates: 0,
    cvOutputs: 0,
    hasOLED: false,
    hasMidi: true,
    audioChannels: { in: 2, out: 2 },
    knobNames: ['knob1', 'knob2'],
    promptFragment: `You are programming a Daisy Pod — a compact desktop synth module.

Hardware:
- Global object: \`DaisyPod pod;\`
- Init: \`pod.Init();\` then \`pod.StartAudio(AudioCallback);\`
- Audio callback: \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
- 2 knobs: \`pod.knob1.Process();\` then \`pod.knob1.Value()\` (returns 0.0-1.0). Same for knob2.
- 2 buttons: \`pod.button1.RisingEdge()\` / \`pod.button1.Pressed()\`, same for button2
- 2 RGB LEDs: \`pod.led1.Set(r, g, b);\` \`pod.led2.Set(r, g, b);\` then \`pod.UpdateLeds();\`
- Encoder: \`pod.encoder.Increment()\` returns +1/-1/0

Call \`pod.ProcessAllControls();\` at the start of AudioCallback.
KNOB LABELS: Add \`// Label\` comments on knob read lines.`,
    template: `#include "daisy_pod.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisyPod pod;
Oscillator osc;

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
    pod.ProcessAllControls();
    float freq = fmap(pod.knob1.Value(), 20.f, 2000.f, Mapping::LOG); // Frequency
    float amp = pod.knob2.Value(); // Volume
    osc.SetFreq(freq);
    osc.SetAmp(amp);
    for (size_t i = 0; i < size; i++) {
        float sig = osc.Process();
        out[0][i] = sig;
        out[1][i] = sig;
    }
}

int main(void) {
    pod.Init();
    osc.Init(pod.AudioSampleRate());
    osc.SetWaveform(Oscillator::WAVE_SAW);
    pod.StartAudio(AudioCallback);
    while(1) {
        pod.UpdateLeds();
    }
}
`,
  },

  petal: {
    id: 'petal',
    name: 'Daisy Petal',
    className: 'DaisyPetal',
    header: 'daisy_petal.h',
    description: '6 knobs, 4 switches, 8 RGB LEDs, encoder, stereo guitar pedal',
    knobs: 6,
    gates: 0,
    cvOutputs: 0,
    hasOLED: false,
    hasMidi: true,
    audioChannels: { in: 2, out: 2 },
    knobNames: ['knob1', 'knob2', 'knob3', 'knob4', 'knob5', 'knob6'],
    promptFragment: `You are programming a Daisy Petal — a guitar effects pedal platform.

Hardware:
- Global object: \`DaisyPetal petal;\`
- Init: \`petal.Init();\` then \`petal.StartAudio(AudioCallback);\`
- Audio callback: \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
- 6 knobs: \`petal.knob[0].Process(); float val = petal.knob[0].Value();\` (indices 0-5)
- 4 footswitches: \`petal.switches[0].RisingEdge()\` (indices 0-3)
- Encoder: \`petal.encoder.Increment()\` and \`petal.encoder.RisingEdge()\`
- 8 RGB LEDs: \`petal.SetRingLed(index, r, g, b);\` (ring LEDs 0-7)
- Footswitch LEDs: \`petal.SetFootswitchLed(index, brightness);\` (0-3)

Call \`petal.ProcessAllControls();\` at start of AudioCallback.
Great for effects chains (distortion, delay, reverb, chorus).
KNOB LABELS: Add \`// Label\` comments on knob read lines.`,
    template: `#include "daisy_petal.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisyPetal petal;
ReverbSc reverb;
bool bypass = true;

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
    petal.ProcessAllControls();
    if (petal.switches[0].RisingEdge()) bypass = !bypass;
    float mix = petal.knob[0].Value(); // Dry/Wet
    float feedback = fmap(petal.knob[1].Value(), 0.3f, 0.99f); // Feedback
    float lpfreq = fmap(petal.knob[2].Value(), 1000.f, 18000.f, Mapping::LOG); // Tone
    reverb.SetFeedback(feedback);
    reverb.SetLpFreq(lpfreq);
    for (size_t i = 0; i < size; i++) {
        float dry_l = in[0][i];
        float dry_r = in[1][i];
        if (bypass) {
            out[0][i] = dry_l;
            out[1][i] = dry_r;
        } else {
            float wet_l, wet_r;
            reverb.Process(dry_l, dry_r, &wet_l, &wet_r);
            out[0][i] = dry_l * (1.f - mix) + wet_l * mix;
            out[1][i] = dry_r * (1.f - mix) + wet_r * mix;
        }
    }
    petal.SetFootswitchLed(0, bypass ? 0.f : 1.f);
    petal.UpdateLeds();
}

int main(void) {
    petal.Init();
    reverb.Init(petal.AudioSampleRate());
    reverb.SetFeedback(0.85f);
    reverb.SetLpFreq(10000.f);
    petal.StartAudio(AudioCallback);
    while(1) {}
}
`,
  },

  field: {
    id: 'field',
    name: 'Daisy Field',
    className: 'DaisyField',
    header: 'daisy_field.h',
    description: '8 knobs, 2 CV inputs, OLED, 16-key keyboard, 8 LED sliders',
    knobs: 8,
    gates: 0,
    cvOutputs: 2,
    hasOLED: true,
    hasMidi: true,
    audioChannels: { in: 2, out: 2 },
    knobNames: ['knob1','knob2','knob3','knob4','knob5','knob6','knob7','knob8'],
    promptFragment: `You are programming a Daisy Field — a fully-featured synth/sampler platform.

Hardware:
- Global object: \`DaisyField field;\`
- Init: \`field.Init();\` then \`field.StartAudio(AudioCallback);\`
- Audio callback: \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
- 8 knobs: \`field.knob[0].Process(); float val = field.knob[0].Value();\` (indices 0-7)
- 16-key capacitive keyboard: \`field.KeyboardState(key)\` returns true if touched (0-15)
- \`field.KeyboardRisingEdge(key)\` / \`field.KeyboardFallingEdge(key)\`
- 8 LED sliders: \`field.led_driver.SetLed(index, brightness);\`
- 2 CV inputs: Read via ADC
- 2 CV/gate outputs: \`field.seed.dac.WriteValue(DacHandle::Channel::ONE, value);\`
- 128x64 OLED: \`field.display.Fill(false); field.display.WriteString("text", Font_7x10, true); field.display.Update();\`

Call \`field.ProcessAllControls();\` at start of AudioCallback.
The keyboard maps naturally to chromatic notes — great for playable instruments.
KNOB LABELS: Add \`// Label\` comments on knob read lines.`,
    template: `#include "daisy_field.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisyField field;
Oscillator osc;
Adsr env;
bool gate = false;

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
    field.ProcessAllControls();
    float freq = fmap(field.knob[0].Value(), 20.f, 2000.f, Mapping::LOG); // Frequency
    float amp = field.knob[1].Value(); // Volume
    // Keyboard — play chromatic from C4
    for (int k = 0; k < 16; k++) {
        if (field.KeyboardRisingEdge(k)) {
            freq = mtof(60 + k);
            gate = true;
        }
        if (field.KeyboardFallingEdge(k)) {
            gate = false;
        }
    }
    osc.SetFreq(freq);
    for (size_t i = 0; i < size; i++) {
        float envSig = env.Process(gate);
        float sig = osc.Process() * envSig * amp;
        out[0][i] = sig;
        out[1][i] = sig;
    }
}

int main(void) {
    field.Init();
    osc.Init(field.AudioSampleRate());
    osc.SetWaveform(Oscillator::WAVE_SAW);
    env.Init(field.AudioSampleRate());
    env.SetTime(ADSR_SEG_ATTACK, 0.01f);
    env.SetTime(ADSR_SEG_DECAY, 0.1f);
    env.SetSustainLevel(0.7f);
    env.SetTime(ADSR_SEG_RELEASE, 0.3f);
    field.StartAudio(AudioCallback);
    while(1) {
        field.display.Fill(false);
        field.display.SetCursor(0, 0);
        field.display.WriteString("DaisyField", Font_7x10, true);
        field.display.Update();
    }
}
`,
  },
};

export const BOARD_IDS = Object.keys(BOARDS);
export const DEFAULT_BOARD = 'patch';

/**
 * Get the system prompt fragment for a board, including code constraints.
 */
export function getBoardPromptFragment(boardId) {
  const board = BOARDS[boardId];
  if (!board) return BOARDS[DEFAULT_BOARD].promptFragment;
  return board.promptFragment;
}

/**
 * Get the starter template code for a board.
 */
export function getBoardTemplate(boardId) {
  const board = BOARDS[boardId];
  if (!board) return BOARDS[DEFAULT_BOARD].template;
  return board.template;
}

/**
 * Get the number of knobs for the UI to render.
 */
export function getBoardKnobCount(boardId) {
  const board = BOARDS[boardId];
  return board ? board.knobs : 4;
}
