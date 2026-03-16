// Browser WASM wrapper prefix — prepended to user code before compilation
// Defines the global state that JS writes to via setKnob/setGate/etc.

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

// --- user code begins below ---
