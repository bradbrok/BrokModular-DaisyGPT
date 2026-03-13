// --- end of user code ---
// Browser WASM wrapper suffix — provides extern "C" exports for AudioWorklet
// These functions are called by worklet-processor.js

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
    if (index >= 0 && index < 4) daisy_knob[index] = value;
}

void setGate(int index, int value) {
    if (index >= 0 && index < 2) daisy_gate[index] = (value != 0);
}

void setPitchCV(float cv) { daisy_pitch_cv = cv; }
void setVelocity(float vel) { daisy_velocity = vel; }
void setPitchBend(float pb) { daisy_pitchbend = pb; }

} // extern "C"
