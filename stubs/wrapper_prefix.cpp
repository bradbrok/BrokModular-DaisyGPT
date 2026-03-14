// Browser WASM wrapper prefix — prepended to user code before compilation
// Defines the global state that JS writes to via setKnob/setGate/etc.

extern "C" {
  float daisy_knob[4] = {0.5f, 0.5f, 0.5f, 0.5f};
  bool  daisy_gate[2] = {false, false};
  float daisy_sample_rate = 48000.0f;
  float daisy_pitch_cv = 0.0f;
  float daisy_velocity = 0.0f;
  float daisy_pitchbend = 0.0f;
  float daisy_cv_in[4] = {0.0f, 0.0f, 0.0f, 0.0f};

  // Hardware peripheral state (Advanced Mode — browser simulation)
  int     daisy_encoder_pos = 0;
  bool    daisy_encoder_btn = false;
  uint8_t daisy_display_buffer[1024] = {};  // 128x64 monochrome
  float   daisy_led_state[8] = {};          // up to 8 LEDs
  float   daisy_dac_out[2] = {};            // 2 DAC channels
  float   daisy_adc_extra[8] = {};          // extra ADC channels
}

// --- user code begins below ---
