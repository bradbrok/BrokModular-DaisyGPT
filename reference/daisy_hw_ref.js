// libDaisy Hardware Peripheral API Reference — for Advanced Mode
// Covers GPIO, DAC, ADC, OLED, LED, Encoder, Switch, I2C, SPI + board pin maps

export const DAISY_HW_REFERENCE = `
# libDaisy Hardware Peripheral Reference

Machine-readable reference for Daisy hardware peripherals beyond DSP.
Use these APIs when building real Eurorack modules with displays, LEDs, encoders, and extra CV I/O.

---

## GPIO — General Purpose I/O

### daisy::GPIO
Direct pin control for LEDs, buttons, and logic signals.
\`\`\`
Init(Pin pin, Mode mode)
  // Mode::INPUT, Mode::OUTPUT, Mode::OPEN_DRAIN
Read() → bool
Write(bool state)
Toggle()
\`\`\`
**Usage:**
\`\`\`cpp
GPIO led_pin;
led_pin.Init(seed.GetPin(0, 7), GPIO::Mode::OUTPUT);  // Port A, Pin 7
led_pin.Write(true);   // on
led_pin.Toggle();      // off
\`\`\`

---

## DAC — CV Output (12-bit, 2 channels)

### DacHandle
Internal STM32H750 DAC. 2 channels, 12-bit resolution (0-4095 → 0-3.3V).
\`\`\`
Init(Config cfg)
WriteValue(Channel chn, uint16_t val)  // 0-4095
Start()                                // for DMA mode

Channel: DAC_CHN_1 (PA4), DAC_CHN_2 (PA5), DAC_CHN_BOTH
\`\`\`
**Voltage conversion:**
\`\`\`cpp
// 0-3.3V range (raw DAC)
uint16_t voltsToDAC(float volts) {
    return static_cast<uint16_t>((volts / 3.3f) * 4095.f);
}

// 1V/Oct CV output (assuming op-amp scales 0-3.3V → 0-5V)
// C2=0V, C3=1V, C4=2V, etc.
float cvVoltage = (midiNote - 36) / 12.f;  // C2 = MIDI 36
uint16_t dacVal = voltsToDAC(cvVoltage * (3.3f / 5.f));
seed.dac.WriteValue(DacHandle::DAC_CHN_1, dacVal);
\`\`\`
**Note:** On DaisySeed, DAC channels are available on seed.dac. On DaisyPatch SM, use patch_sm.dac.
WriteValue() is safe to call inside AudioCallback for sample-accurate CV output.

---

## ADC — CV Input Expansion (16-bit, up to 16 channels)

### AdcHandle + AdcChannelConfig
Configure additional analog inputs beyond built-in knobs.
\`\`\`
AdcChannelConfig:
  InitSingle(Pin pin)
  InitMux(Pin pin, size_t mux_channels, Pin mux_sel_pins[3])

AdcHandle (accessed via seed.adc or patch_sm.adc):
  Init(AdcChannelConfig* cfg, size_t num_channels)
  Start()
  GetFloat(uint8_t chn) → float  // 0.0-1.0
  GetMuxFloat(uint8_t mux_idx, uint8_t chn) → float
\`\`\`
**Example — 4 extra CV inputs on DaisySeed:**
\`\`\`cpp
AdcChannelConfig adc_cfg[4];
adc_cfg[0].InitSingle(seed.GetPin(15));  // A0
adc_cfg[1].InitSingle(seed.GetPin(16));  // A1
adc_cfg[2].InitSingle(seed.GetPin(17));  // A2
adc_cfg[3].InitSingle(seed.GetPin(18));  // A3

seed.adc.Init(adc_cfg, 4);
seed.adc.Start();

// In AudioCallback or main loop:
float cv1 = seed.adc.GetFloat(0);  // 0.0-1.0
float cv2 = seed.adc.GetFloat(1);
\`\`\`
**Multiplexed inputs** (8:1 mux on one pin):
\`\`\`cpp
Pin mux_sel[3] = {seed.GetPin(20), seed.GetPin(21), seed.GetPin(22)};
adc_cfg[0].InitMux(seed.GetPin(15), 8, mux_sel);
// Read: seed.adc.GetMuxFloat(0, channel)  // channel 0-7
\`\`\`

---

## OLED Display — SSD130x (128x64 SPI)

### OledDisplay<SSD130x4WireSpi128x64Driver>
SPI-connected OLED display. 128x64 pixels, monochrome.
\`\`\`
Init(Config cfg)
Fill(bool on)                          // clear or fill screen
DrawPixel(uint8_t x, uint8_t y, bool on)
DrawLine(uint8_t x1, uint8_t y1, uint8_t x2, uint8_t y2, bool on)
DrawRect(uint8_t x1, uint8_t y1, uint8_t x2, uint8_t y2, bool on, bool fill = false)
DrawCircle(uint8_t x, uint8_t y, uint8_t r, bool on)
SetCursor(uint8_t x, uint8_t y)
WriteString(const char* str, FontDef font, bool on)
WriteStringAligned(const char* str, FontDef font, Rectangle bounds, Alignment align, bool on)
Update()                               // flush framebuffer to display via SPI
\`\`\`
**Fonts:** \`Font_4x5\`, \`Font_6x8\`, \`Font_7x10\`, \`Font_11x18\`, \`Font_16x26\`
**Rectangle:** \`{uint8_t x, y, width, height}\`

**CRITICAL: Display updates are SLOW (~1ms SPI transfer). NEVER call Update() in AudioCallback.**
Update the display in the main loop at 30-60Hz using a timer or frame counter.

**Init pattern (DaisySeed + SPI OLED):**
\`\`\`cpp
using MyOledDisplay = OledDisplay<SSD130x4WireSpi128x64Driver>;
MyOledDisplay display;

void InitDisplay(DaisySeed& seed) {
    MyOledDisplay::Config disp_cfg;
    disp_cfg.driver_config.transport_config.pin_config.dc    = seed.GetPin(9);   // D9
    disp_cfg.driver_config.transport_config.pin_config.reset  = seed.GetPin(30);  // D30
    display.Init(disp_cfg);
}
\`\`\`

**Drawing pattern (main loop):**
\`\`\`cpp
// In main() after StartAudio:
uint32_t screen_timer = System::GetNow();
while (true) {
    if (System::GetNow() - screen_timer > 33) {  // ~30 FPS
        screen_timer = System::GetNow();
        display.Fill(false);  // clear

        // Draw parameter values
        char buf[32];
        snprintf(buf, sizeof(buf), "Freq: %.0f Hz", freq);
        display.SetCursor(0, 0);
        display.WriteString(buf, Font_7x10, true);

        snprintf(buf, sizeof(buf), "Res:  %.2f", resonance);
        display.SetCursor(0, 12);
        display.WriteString(buf, Font_7x10, true);

        // Draw a level bar
        uint8_t bar_w = static_cast<uint8_t>(level * 120.f);
        display.DrawRect(4, 50, 4 + bar_w, 58, true, true);

        display.Update();  // send to screen
    }
}
\`\`\`

---

## LED — PWM Brightness Control

### Led
Software PWM LED with smooth brightness control.
\`\`\`
Init(Pin pin, bool invert, float samplerate)  // samplerate = update rate (e.g. 1000)
Set(float brightness)                          // 0.0-1.0
Update()                                       // call after Set(), at samplerate
\`\`\`
**Example:**
\`\`\`cpp
Led led1, led2;
led1.Init(seed.GetPin(28), false, 1000.f);
led2.Init(seed.GetPin(29), false, 1000.f);

// In a 1kHz timer or main loop:
led1.Set(gate_active ? 1.f : 0.f);
led1.Update();

led2.Set(output_level);  // VU meter
led2.Update();
\`\`\`
**For simple on/off without PWM:** Use GPIO directly:
\`\`\`cpp
GPIO led_pin;
led_pin.Init(seed.GetPin(28), GPIO::Mode::OUTPUT);
led_pin.Write(gate_active);
\`\`\`

---

## Encoder — Rotary Encoder with Push Button

### Encoder
Quadrature rotary encoder with debounced push button.
\`\`\`
Init(Pin a, Pin b, Pin click, float update_rate)  // update_rate in Hz (e.g. 1000)
Debounce()          // call at update_rate
Increment() → int   // +1 clockwise, -1 counter-clockwise, 0 no change
Pressed() → bool    // button currently held
FallingEdge() → bool  // button just pressed this cycle
RisingEdge() → bool   // button just released this cycle
TimeHeldMs() → float   // how long button held
\`\`\`
**Example — parameter selector:**
\`\`\`cpp
Encoder encoder;
encoder.Init(seed.GetPin(26), seed.GetPin(27), seed.GetPin(28), 1000.f);

int selected_param = 0;
const int NUM_PARAMS = 4;

// In a 1kHz timer callback or main loop:
encoder.Debounce();
selected_param += encoder.Increment();
selected_param = (selected_param + NUM_PARAMS) % NUM_PARAMS;  // wrap around

if (encoder.FallingEdge()) {
    // Button pressed — toggle edit mode, save preset, etc.
}
\`\`\`
**IMPORTANT:** Call Debounce() at a consistent rate (500Hz-2kHz). Do NOT call in AudioCallback.
Use System::GetNow() timer in main loop, or a separate TimerHandle callback.

---

## Switch — Debounced Button / Toggle

### Switch
Momentary or toggle switch with debouncing.
\`\`\`
Init(Pin pin, float update_rate, Type type = TYPE_MOMENTARY, Polarity pol = POLARITY_NORMAL)
Debounce()
Pressed() → bool
FallingEdge() → bool   // just pressed
RisingEdge() → bool    // just released
TimeHeldMs() → float
\`\`\`
**Type:** \`TYPE_TOGGLE\`, \`TYPE_MOMENTARY\`
**Polarity:** \`POLARITY_NORMAL\`, \`POLARITY_INVERTED\`

---

## I2C — Inter-Integrated Circuit Bus

### I2CHandle
For I2C OLED displays, external DACs, sensor ICs, etc.
\`\`\`
Init(Config cfg)
TransmitBlocking(uint16_t address, uint8_t* data, uint16_t size, uint32_t timeout)
ReceiveBlocking(uint16_t address, uint8_t* data, uint16_t size, uint32_t timeout)
\`\`\`
**Config:** \`periph\` (I2C_1, I2C_2), \`speed\` (I2C_100KHZ, I2C_400KHZ, I2C_1MHZ), \`pin_config\` (\`scl\`, \`sda\`)

---

## SPI — Serial Peripheral Interface

### SpiHandle
For SPI OLED displays, external DACs (DAC8568), shift registers, etc.
\`\`\`
Init(Config cfg)
BlockingTransmit(uint8_t* data, size_t size, uint32_t timeout)
\`\`\`

---

## System Utilities

### System
\`\`\`
System::GetNow() → uint32_t      // milliseconds since boot
System::Delay(uint32_t ms)       // blocking delay
System::GetUs() → uint32_t       // microseconds since boot
System::GetTickFreq() → uint32_t // timer tick frequency
\`\`\`

### TimerHandle (for consistent update rates)
\`\`\`
Init(Config cfg)  // Config: periph, dir, period (auto-reload value)
Start()
SetCallback(std::function<void(void)> cb)
SetPeriod(uint32_t period)
\`\`\`

---

## Board Pin Maps

### DaisySeed (bare board — user wires everything)
\`\`\`
Pins: seed.GetPin(N) where N is the header pin number (0-30)
Named: DaisySeed::A0-A11 (analog-capable), DaisySeed::D0-D30 (all digital)

Common wiring:
  OLED SPI: DC=pin 9, Reset=pin 30, (MOSI/SCK on SPI1 default pins)
  Encoder:  A=pin 26, B=pin 27, Click=pin 28
  LEDs:     Any free GPIO (pins 22-25 are convenient)
  CV Out:   DAC1=PA4 (pin 22), DAC2=PA5 (pin 23)
  CV In:    Any ADC-capable pin (A0-A11)

Audio I/O: Built-in stereo codec (SAI)
  OUT_L=pin 18, OUT_R=pin 19, IN_L=pin 16, IN_R=pin 17
\`\`\`

### DaisyPatch (Eurorack module — 4 knobs, 2 gates, OLED)
\`\`\`
Built-in: 4 knobs (CTRL_1-4), 2 gate inputs, 4 audio I/O, OLED header
Free pins for expansion: limited — check schematic for unused GPIO

// Access via DaisyPatch class:
patch.GetKnobValue(DaisyPatch::CTRL_1)  // built-in knobs
patch.gate_input[0].Trig()               // built-in gates
// For OLED: patch has a built-in display member on Rev4+
\`\`\`

### DaisyPatch SM (submodule — most I/O)
\`\`\`
Named pins: DaisyPatchSM::A1-A9, B1-B10, C1-C10, D1-D10
Built-in: 4 audio I/O channels, USB, plenty of GPIO

CV Inputs (ADC):  A1-A9 (up to 8 CV inputs via onboard ADC)
CV Outputs (DAC): patch_sm.dac (2 channels, same as Seed)
Gate Outputs:     Any GPIO pin
Gate Inputs:      Any GPIO pin

// Access via DaisyPatchSM class:
patch_sm.Init();
patch_sm.SetAudioBlockSize(48);
float cv = patch_sm.GetAdcValue(0);  // CV input channel 0

Common wiring:
  OLED SPI: Use pins C7(DC), C8(Reset) or any free GPIO
  Encoder:  Use pins D7(A), D8(B), D9(Click)
  LEDs:     B5-B8 are convenient
\`\`\`

---

## Important Patterns

### Main Loop with Display + Controls (DaisySeed)
\`\`\`cpp
int main(void) {
    DaisySeed seed;
    seed.Init();

    // Init audio, DSP objects, display, encoder, LEDs...
    InitDisplay(seed);
    encoder.Init(seed.GetPin(26), seed.GetPin(27), seed.GetPin(28), 1000.f);
    led1.Init(seed.GetPin(22), false, 1000.f);

    seed.StartAudio(AudioCallback);

    uint32_t display_timer = System::GetNow();
    uint32_t ctrl_timer = System::GetNow();

    while (true) {
        uint32_t now = System::GetNow();

        // 1kHz control rate (encoder, switches, LEDs)
        if (now - ctrl_timer >= 1) {
            ctrl_timer = now;
            encoder.Debounce();
            // process encoder, update LEDs, etc.
            led1.Set(gate ? 1.f : 0.f);
            led1.Update();
        }

        // 30 FPS display update
        if (now - display_timer >= 33) {
            display_timer = now;
            display.Fill(false);
            // draw UI...
            display.Update();
        }
    }
}
\`\`\`

### AudioCallback with DAC CV Output
\`\`\`cpp
void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
    for (size_t i = 0; i < size; i++) {
        // DSP processing...
        float cv_out = lfo.Process();  // -1 to 1
        uint16_t dac_val = static_cast<uint16_t>((cv_out + 1.f) * 0.5f * 4095.f);
        seed.dac.WriteValue(DacHandle::DAC_CHN_1, dac_val);

        out[0][i] = audio_out;
        out[1][i] = audio_out;
    }
}
\`\`\`
`;
