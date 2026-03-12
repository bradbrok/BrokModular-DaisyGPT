#pragma once
// Browser stub — replaces daisy_patch.h for WASM compilation
// Knob values and gate state are written by JS glue before each AudioCallback

#include <cstddef>
#include <cstdint>
#include <cmath>

// Stub out SDRAM attribute (not relevant in browser)
#define DSY_SDRAM_BSS

namespace daisy {
    // Minimal AudioHandle types for compatibility
    namespace AudioHandle {
        using InputBuffer = const float* const*;
        using OutputBuffer = float**;
    }
}

// Global knob/gate state written by JS glue code
extern "C" {
    extern float daisy_knob[4];       // 0.0 - 1.0
    extern bool  daisy_gate[2];       // trigger state
    extern float daisy_sample_rate;   // default 48000
    extern float daisy_pitch_cv;      // 1V/Oct: (note-60)/12, C4=0.0
    extern float daisy_velocity;      // 0.0-1.0
    extern float daisy_pitchbend;     // -1.0 to 1.0
    extern float daisy_cv_in[4];      // CV inputs (general purpose)
}

// Convert 1V/Oct CV to frequency (C4=0.0 → 261.63Hz, A4=0.75 → 440Hz)
inline float cvToFreq(float cv) {
    return 440.0f * powf(2.0f, cv - 0.75f);
}

// Mapping enum used by fmap()
enum Mapping { LINEAR, EXP, LOG };

// DaisySP utility functions (normally in Utility/dsp.h)
#ifndef PI_F
#define PI_F 3.14159265358979f
#endif
#ifndef TWOPI_F
#define TWOPI_F 6.28318530717959f
#endif
#ifndef HALFPI_F
#define HALFPI_F 1.57079632679490f
#endif

static const float kOneTwelfth = 1.0f / 12.0f;

inline float mtof(float m) {
    return powf(2.0f, (m - 69.0f) / 12.0f) * 440.0f;
}

inline float fclamp(float in, float mn, float mx) {
    return fminf(fmaxf(in, mn), mx);
}

inline float fmap(float in, float mn, float mx, Mapping curve = LINEAR) {
    switch (curve) {
        case EXP: {
            float v = in * in;
            return mn + v * (mx - mn);
        }
        case LOG: {
            float v = 1.0f - in;
            v = 1.0f - v * v;
            return mn + v * (mx - mn);
        }
        default:
            return mn + in * (mx - mn);
    }
}

inline float SoftClip(float x) {
    if (x > 3.0f) return 1.0f;
    if (x < -3.0f) return -1.0f;
    return x * (27.0f + x * x) / (27.0f + 9.0f * x * x);
}

inline float SoftLimit(float x) {
    return x * (27.0f + x * x) / (27.0f + 9.0f * x * x);
}

inline void fonepole(float& out, float in, float coeff) {
    out += coeff * (in - out);
}

inline void TestFloat(float& x, float y = 0.0f) {
    if (std::isnan(x) || std::isinf(x)) x = y;
}

// DaisyPatch stub
struct DaisyPatch {
    static constexpr int CTRL_1 = 0;
    static constexpr int CTRL_2 = 1;
    static constexpr int CTRL_3 = 2;
    static constexpr int CTRL_4 = 3;

    struct Control {
        float value = 0.5f;
        void Process() {}
        float Value() const { return value; }
    } controls[4];

    struct GateInput {
        bool trig = false;
        bool Trig() { bool t = trig; trig = false; return t; }
        bool State() const { return trig; }
    } gate_input[2];

    void Init() {
        for (int i = 0; i < 4; i++) controls[i].value = daisy_knob[i];
        for (int i = 0; i < 2; i++) gate_input[i].trig = daisy_gate[i];
    }

    void ProcessAllControls() {
        for (int i = 0; i < 4; i++) controls[i].value = daisy_knob[i];
        for (int i = 0; i < 2; i++) gate_input[i].trig = daisy_gate[i];
    }

    float GetKnobValue(int idx) const {
        if (idx >= 0 && idx < 4) return daisy_knob[idx];
        return 0.5f;
    }

    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAdc() {}
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                             daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}
};
