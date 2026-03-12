// --- end of user code ---
// Browser WASM wrapper suffix — provides extern "C" exports for AudioWorklet
// These functions are called by worklet-processor.js

static float _in_buf_l[1] = {0.0f};
static float _in_buf_r[1] = {0.0f};
static const float* _in_ptrs[2] = {_in_buf_l, _in_buf_r};
static float _out_buf_l[1] = {0.0f};
static float _out_buf_r[1] = {0.0f};
static float* _out_ptrs[2] = {_out_buf_l, _out_buf_r};

extern "C" {

void init(float sr) {
    daisy_sample_rate = sr;
    main();
}

float processSample() {
    _out_buf_l[0] = 0.0f;
    _out_buf_r[0] = 0.0f;
    AudioCallback(
        (daisy::AudioHandle::InputBuffer)_in_ptrs,
        (daisy::AudioHandle::OutputBuffer)_out_ptrs,
        1
    );
    return _out_buf_l[0];
}

void setKnob(int index, float value) {
    if (index >= 0 && index < 4) daisy_knob[index] = value;
}

void setGate(int index, int value) {
    if (index >= 0 && index < 2) daisy_gate[index] = (value != 0);
}

void setPitchCV(float cv) { daisy_pitch_cv = cv; }
void setVelocity(float vel) { daisy_velocity = vel; }
void setPitchBend(float pb) { daisy_pitchbend = pb; }

} // extern "C"
