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
    extern float daisy_knob[8];       // 0.0 - 1.0 (up to 8 for Patch SM / Field)
    extern bool  daisy_gate[2];       // gate input state
    extern bool  daisy_gate_out[2];   // gate output state
    extern float daisy_sample_rate;   // default 48000
    extern float daisy_pitch_cv;      // 1V/Oct: (note-60)/12, C4=0.0
    extern float daisy_velocity;      // 0.0-1.0
    extern float daisy_pitchbend;     // -1.0 to 1.0
    extern float daisy_cv_in[4];      // CV inputs (general purpose)
    extern float daisy_cv_out[2];     // CV outputs (DAC)
}

// Convert 1V/Oct CV to frequency (C4=0.0 → 261.63Hz, A4=0.75 → 440Hz)
inline float cvToFreq(float cv) {
    return 440.0f * powf(2.0f, cv - 0.75f);
}

// DaisySP utility macros (normally in Utility/dsp.h)
#ifndef PI_F
#define PI_F 3.14159265358979f
#endif
#ifndef TWOPI_F
#define TWOPI_F 6.28318530717959f
#endif
#ifndef HALFPI_F
#define HALFPI_F 1.57079632679490f
#endif

// ============================================================
// DaisySP DSP Module Stubs
// ============================================================

namespace daisysp {

// --- Core utility functions ---
static const float kOneTwelfth = 1.0f / 12.0f;

enum Mapping { LINEAR, EXP, LOG };

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

// --- Waveform enums ---
enum {
    WAVE_SIN,
    WAVE_TRI,
    WAVE_SAW,
    WAVE_RAMP,
    WAVE_SQUARE,
    WAVE_POLYBLEP_TRI,
    WAVE_POLYBLEP_SAW,
    WAVE_POLYBLEP_SQUARE,
    WAVE_LAST
};

// --- Envelope segment enums ---
enum {
    ADSR_SEG_IDLE = 0,
    ADSR_SEG_ATTACK = 1,
    ADSR_SEG_DECAY = 2,
    ADSR_SEG_RELEASE = 4
};
enum {
    ADENV_SEG_IDLE,
    ADENV_SEG_ATTACK,
    ADENV_SEG_DECAY,
    ADENV_SEG_LAST
};

// --- CrossFade curve enums ---
enum {
    CROSSFADE_LIN,
    CROSSFADE_CPOW,
    CROSSFADE_LOG,
    CROSSFADE_EXP
};

// --- SampleHold mode enums ---
enum {
    MODE_SAMPLE_HOLD,
    MODE_TRACK_HOLD
};

// --- Looper mode enums ---
enum {
    NORMAL,
    ONETIME_DUB,
    REPLACE,
    FRIPPERTRONICS
};

// --- OnePole filter mode enums ---
enum {
    FILTER_MODE_LOW_PASS,
    FILTER_MODE_HIGH_PASS
};

// ===================== SYNTHESIS =====================

class Oscillator {
    float phase_ = 0.f, freq_ = 440.f, amp_ = 1.f, pw_ = 0.5f;
    float sr_ = 48000.f;
    uint8_t waveform_ = WAVE_SIN;
    bool eor_ = false, eoc_ = false;
public:
    void Init(float sample_rate) { sr_ = sample_rate; phase_ = 0.f; }
    void SetFreq(float f) { freq_ = f; }
    void SetAmp(float a) { amp_ = a; }
    void SetWaveform(uint8_t wf) { waveform_ = wf; }
    void SetPw(float pw) { pw_ = pw; }
    void PhaseAdd(float p) { phase_ += p; if (phase_ >= 1.f) phase_ -= 1.f; if (phase_ < 0.f) phase_ += 1.f; }
    void Reset(float p = 0.f) { phase_ = p; }
    bool IsEOR() const { return eor_; }
    bool IsEOC() const { return eoc_; }
    bool IsRising() const { return phase_ < 0.5f; }
    bool IsFalling() const { return phase_ >= 0.5f; }
    float Process() {
        float inc = freq_ / sr_;
        float old_phase = phase_;
        phase_ += inc;
        eor_ = false; eoc_ = false;
        if (phase_ >= 1.f) { phase_ -= 1.f; eoc_ = true; }
        if (old_phase < 0.5f && phase_ >= 0.5f) eor_ = true;
        float out = 0.f;
        float p = phase_;
        switch (waveform_) {
            case WAVE_SIN:
                out = sinf(p * TWOPI_F);
                break;
            case WAVE_TRI:
            case WAVE_POLYBLEP_TRI:
                out = (p < 0.5f) ? (4.f * p - 1.f) : (3.f - 4.f * p);
                break;
            case WAVE_SAW:
            case WAVE_POLYBLEP_SAW:
                out = 2.f * p - 1.f;
                break;
            case WAVE_RAMP:
                out = 1.f - 2.f * p;
                break;
            case WAVE_SQUARE:
            case WAVE_POLYBLEP_SQUARE:
                out = (p < pw_) ? 1.f : -1.f;
                break;
            default:
                out = sinf(p * TWOPI_F);
                break;
        }
        return out * amp_;
    }
};

class Fm2 {
    float sr_ = 48000.f, freq_ = 440.f, ratio_ = 1.f, idx_ = 1.f;
    float car_phase_ = 0.f, mod_phase_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; car_phase_ = 0.f; mod_phase_ = 0.f; }
    void SetFrequency(float f) { freq_ = f; }
    void SetRatio(float r) { ratio_ = r; }
    void SetIndex(float i) { idx_ = i; }
    float GetIndex() const { return idx_; }
    void Reset() { car_phase_ = 0.f; mod_phase_ = 0.f; }
    float Process() {
        float mod_freq = freq_ * ratio_;
        mod_phase_ += mod_freq / sr_;
        if (mod_phase_ >= 1.f) mod_phase_ -= 1.f;
        float mod = sinf(mod_phase_ * TWOPI_F) * idx_ * TWOPI_F;
        car_phase_ += freq_ / sr_;
        if (car_phase_ >= 1.f) car_phase_ -= 1.f;
        return sinf(car_phase_ * TWOPI_F + mod);
    }
};

// ===================== FILTERS =====================

class LadderFilter {
    float sr_ = 48000.f, freq_ = 1000.f, res_ = 0.f;
    float pbg_ = 0.5f, drv_ = 1.f;
    float stage_[4] = {};
    float delay_[4] = {};
    int mode_ = 0;
public:
    enum FilterMode { LP24, LP12, BP24, BP12, HP24, HP12 };
    void Init(float sr) { sr_ = sr; for (int i = 0; i < 4; i++) { stage_[i] = 0.f; delay_[i] = 0.f; } }
    void SetFreq(float f) { freq_ = fminf(f, sr_ * 0.45f); }
    void SetRes(float r) { res_ = r; }
    void SetPassbandGain(float pbg) { pbg_ = pbg; }
    void SetInputDrive(float drv) { drv_ = drv; }
    void SetFilterMode(FilterMode m) { mode_ = (int)m; }
    float Process(float in) {
        float cutoff = 2.f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float resonance = res_ * 0.55f;
        in *= drv_;
        in = tanhf(in);
        float feedback = resonance * delay_[3];
        float input = in - feedback;
        for (int i = 0; i < 4; i++) {
            stage_[i] = delay_[i] + cutoff * (tanhf(input) - tanhf(delay_[i]));
            delay_[i] = stage_[i];
            input = stage_[i];
        }
        switch (mode_) {
            case LP24: return stage_[3];
            case LP12: return stage_[1];
            case BP24: return stage_[1] - stage_[3];
            case BP12: return stage_[0] - stage_[1];
            case HP24: return in - stage_[3];
            case HP12: return in - stage_[1];
            default: return stage_[3];
        }
    }
    void ProcessBlock(float* buf, size_t size) {
        for (size_t i = 0; i < size; i++) buf[i] = Process(buf[i]);
    }
};

class Svf {
    float sr_ = 48000.f, freq_ = 1000.f, res_ = 0.f, drive_ = 0.f;
    float low_ = 0.f, high_ = 0.f, band_ = 0.f, notch_ = 0.f, peak_ = 0.f;
    float d1_ = 0.f, d2_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; d1_ = 0.f; d2_ = 0.f; }
    void SetFreq(float f) { freq_ = fminf(f, sr_ / 3.f); }
    void SetRes(float r) { res_ = fmaxf(r, 0.f); }
    void SetDrive(float d) { drive_ = d; }
    void Process(float in) {
        float f = 2.f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = 1.f / (1.f + res_);
        if (drive_ > 0.f) in = tanhf(in * (1.f + drive_));
        high_ = in - q * d1_ - d2_;
        band_ = f * high_ + d1_;
        low_ = f * band_ + d2_;
        notch_ = high_ + low_;
        peak_ = high_ - low_;
        d1_ = band_;
        d2_ = low_;
    }
    float Low() const { return low_; }
    float High() const { return high_; }
    float Band() const { return band_; }
    float Notch() const { return notch_; }
    float Peak() const { return peak_; }
};

class OnePole {
    float out_ = 0.f, freq_ = 0.1f;
    int mode_ = 0; // 0=LP, 1=HP
public:
    void Init() { out_ = 0.f; }
    void SetFrequency(float f) { freq_ = fminf(fmaxf(f, 0.f), 0.497f); }
    void SetFilterMode(int mode) { mode_ = mode; }
    void Reset() { out_ = 0.f; }
    float Process(float in) {
        out_ += freq_ * (in - out_);
        return (mode_ == 0) ? out_ : in - out_;
    }
    void ProcessBlock(float* buf, size_t size) {
        for (size_t i = 0; i < size; i++) buf[i] = Process(buf[i]);
    }
};

class Soap {
    float sr_ = 48000.f, freq_ = 1000.f, bw_ = 100.f;
    float bp_ = 0.f, br_ = 0.f, d1_ = 0.f, d2_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; }
    void SetCenterFreq(float f) { freq_ = f; }
    void SetFilterBandwidth(float b) { bw_ = b; }
    void Process(float in) {
        float f = 2.f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = freq_ / fmaxf(bw_, 1.f);
        float qinv = 1.f / fmaxf(q, 0.5f);
        float hp = in - qinv * d1_ - d2_;
        float bp_out = f * hp + d1_;
        float lp = f * bp_out + d2_;
        d1_ = bp_out; d2_ = lp;
        bp_ = bp_out; br_ = in - bp_out;
    }
    float Bandpass() const { return bp_; }
    float Bandreject() const { return br_; }
};

class DcBlock {
    float sr_ = 48000.f, x1_ = 0.f, y1_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; x1_ = 0.f; y1_ = 0.f; }
    float Process(float in) {
        float y = in - x1_ + 0.995f * y1_;
        x1_ = in; y1_ = y;
        return y;
    }
};

// ===================== EFFECTS =====================

class Overdrive {
    float drive_ = 0.5f;
public:
    void Init() {}
    void SetDrive(float d) { drive_ = d; }
    float Process(float in) {
        float x = in * (1.f + drive_ * 10.f);
        return tanhf(x);
    }
};

class Decimator {
    float sr_factor_ = 1.f, bits_ = 16.f;
    float hold_ = 0.f;
    int count_ = 0;
    bool smooth_ = false;
public:
    void Init() { hold_ = 0.f; count_ = 0; }
    void SetDownsampleFactor(float f) { sr_factor_ = fmaxf(f, 1.f); }
    void SetBitcrushFactor(float f) { bits_ = fmaxf(1.f, 16.f * (1.f - f)); }
    void SetBitsToCrush(const uint8_t& b) { bits_ = 16.f - b; }
    void SetSmoothCrushing(bool s) { smooth_ = s; }
    float Process(float in) {
        count_++;
        if (count_ >= (int)sr_factor_) { count_ = 0; hold_ = in; }
        float q = powf(2.f, bits_);
        return roundf(hold_ * q) / q;
    }
};

class SampleRateReducer {
    float freq_ = 1.f, hold_ = 0.f, phase_ = 0.f;
public:
    void Init() { hold_ = 0.f; phase_ = 0.f; }
    void SetFreq(float f) { freq_ = fmaxf(f, 0.001f); }
    float Process(float in) {
        phase_ += freq_;
        if (phase_ >= 1.f) { phase_ -= 1.f; hold_ = in; }
        return hold_;
    }
};

class Wavefolder {
    float gain_ = 1.f, offset_ = 0.f;
public:
    void Init() {}
    void SetGain(float g) { gain_ = g; }
    void SetOffset(float o) { offset_ = o; }
    float Process(float in) {
        float x = (in + offset_) * gain_;
        // Simple fold: wrap into [-1, 1]
        while (x > 1.f) x = 2.f - x;
        while (x < -1.f) x = -2.f - x;
        return x;
    }
};

class Tremolo {
    float sr_ = 48000.f, phase_ = 0.f, freq_ = 5.f, depth_ = 1.f;
    int waveform_ = WAVE_SIN;
public:
    void Init(float sr) { sr_ = sr; }
    void SetFreq(float f) { freq_ = f; }
    void SetWaveform(int wf) { waveform_ = wf; }
    void SetDepth(float d) { depth_ = d; }
    float Process(float in) {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        float lfo = (waveform_ == WAVE_SIN) ? (sinf(phase_ * TWOPI_F) * 0.5f + 0.5f) : ((phase_ < 0.5f) ? phase_ * 2.f : 2.f - phase_ * 2.f);
        float mod = 1.f - depth_ * lfo;
        return in * mod;
    }
};

class PitchShifter {
    float sr_ = 48000.f, transpose_ = 0.f, fun_ = 0.f;
    float buf_[16384] = {};
    size_t write_pos_ = 0, del_size_ = 16384;
    float read_phase1_ = 0.f, read_phase2_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; for (size_t i = 0; i < 16384; i++) buf_[i] = 0.f; }
    void SetTransposition(const float& t) { transpose_ = t; }
    void SetDelSize(uint32_t s) { del_size_ = (s > 16384) ? 16384 : s; }
    void SetFun(float f) { fun_ = f; }
    float Process(float& in) {
        buf_[write_pos_] = in;
        write_pos_ = (write_pos_ + 1) % del_size_;
        float ratio = powf(2.f, transpose_ / 12.f);
        float rate = 1.f - ratio;
        read_phase1_ += rate;
        if (read_phase1_ >= (float)del_size_) read_phase1_ -= (float)del_size_;
        if (read_phase1_ < 0.f) read_phase1_ += (float)del_size_;
        read_phase2_ = read_phase1_ + (float)del_size_ * 0.5f;
        if (read_phase2_ >= (float)del_size_) read_phase2_ -= (float)del_size_;
        size_t idx1 = (size_t)read_phase1_ % del_size_;
        size_t idx2 = (size_t)read_phase2_ % del_size_;
        float win1 = sinf(read_phase1_ / (float)del_size_ * PI_F);
        float win2 = sinf(read_phase2_ / (float)del_size_ * PI_F);
        return buf_[idx1] * win1 * win1 + buf_[idx2] * win2 * win2;
    }
};

// ===================== DRUMS =====================

class AnalogBassDrum {
    float sr_ = 48000.f, freq_ = 60.f, tone_ = 0.5f, decay_ = 0.5f;
    float accent_ = 0.5f, attack_fm_ = 0.f, self_fm_ = 0.f;
    bool sustain_ = false, trig_ = false;
    float phase_ = 0.f, env_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { trig_ = true; env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetAccent(float a) { accent_ = a; }
    void SetFreq(float f) { freq_ = f; }
    void SetTone(float t) { tone_ = t; }
    void SetDecay(float d) { decay_ = d; }
    void SetAttackFmAmount(float a) { attack_fm_ = a; }
    void SetSelfFmAmount(float a) { self_fm_ = a; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        float dec = 1.f - (1.f - decay_) * 0.01f;
        env_ *= dec;
        float f = freq_ + env_ * freq_ * tone_ * 4.f;
        phase_ += f / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        return sinf(phase_ * TWOPI_F) * env_ * accent_;
    }
};

class AnalogSnareDrum {
    float sr_ = 48000.f, freq_ = 200.f, tone_ = 0.5f, decay_ = 0.5f;
    float accent_ = 0.5f, snappy_ = 0.5f;
    bool sustain_ = false;
    float phase_ = 0.f, env_ = 0.f;
    uint32_t noise_seed_ = 12345;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetAccent(float a) { accent_ = a; }
    void SetFreq(float f) { freq_ = f; }
    void SetTone(float t) { tone_ = t; }
    void SetDecay(float d) { decay_ = d; }
    void SetSnappy(float s) { snappy_ = s; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        float dec = 1.f - (1.f - decay_) * 0.005f;
        env_ *= dec;
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        float body = sinf(phase_ * TWOPI_F) * (1.f - snappy_);
        float snap = noise * snappy_;
        return (body + snap) * env_ * accent_;
    }
};

class SyntheticBassDrum {
    float sr_ = 48000.f, freq_ = 60.f, tone_ = 0.5f, decay_ = 0.5f;
    float accent_ = 0.5f, dirt_ = 0.f, fm_amt_ = 0.f, fm_dec_ = 0.5f;
    bool sustain_ = false;
    float phase_ = 0.f, env_ = 0.f, fm_env_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { env_ = 1.f; fm_env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetAccent(float a) { accent_ = a; }
    void SetFreq(float f) { freq_ = f; }
    void SetTone(float t) { tone_ = t; }
    void SetDecay(float d) { decay_ = d; }
    void SetDirtiness(float d) { dirt_ = d; }
    void SetFmEnvelopeAmount(float a) { fm_amt_ = a; }
    void SetFmEnvelopeDecay(float d) { fm_dec_ = d; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 1.f - (1.f - decay_) * 0.01f;
        fm_env_ *= 1.f - (1.f - fm_dec_) * 0.02f;
        float f = freq_ * (1.f + fm_env_ * fm_amt_ * 8.f);
        phase_ += f / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        return sinf(phase_ * TWOPI_F) * env_ * accent_;
    }
};

class SyntheticSnareDrum {
    float sr_ = 48000.f, freq_ = 200.f, fm_amt_ = 0.5f, decay_ = 0.5f;
    float accent_ = 0.5f, snappy_ = 0.5f;
    bool sustain_ = false;
    float phase_ = 0.f, env_ = 0.f;
    uint32_t noise_seed_ = 54321;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetAccent(float a) { accent_ = a; }
    void SetFreq(float f) { freq_ = f; }
    void SetFmAmount(float f) { fm_amt_ = f; }
    void SetDecay(float d) { decay_ = d; }
    void SetSnappy(float s) { snappy_ = s; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 1.f - (1.f - decay_) * 0.005f;
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        return (sinf(phase_ * TWOPI_F) * (1.f - snappy_) + noise * snappy_) * env_ * accent_;
    }
};

// HiHat helper types
struct SquareNoise {};
struct RingModNoise {};
struct LinearVCA {};
struct SwingVCA {};

template<typename NoiseSource = SquareNoise, typename VCA = LinearVCA, bool resonance = true>
class HiHat {
    float sr_ = 48000.f, freq_ = 3000.f, tone_ = 0.5f, decay_ = 0.5f;
    float accent_ = 0.5f, noisiness_ = 0.5f;
    bool sustain_ = false;
    float env_ = 0.f;
    uint32_t noise_seed_ = 98765;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetAccent(float a) { accent_ = a; }
    void SetFreq(float f) { freq_ = f; }
    void SetTone(float t) { tone_ = t; }
    void SetDecay(float d) { decay_ = d; }
    void SetNoisiness(float n) { noisiness_ = n; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 1.f - (1.f - decay_) * 0.003f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        return noise * env_ * accent_;
    }
};

// ===================== PHYSICAL MODELING =====================

class String {
    float sr_ = 48000.f, freq_ = 440.f, brightness_ = 0.5f, damping_ = 0.5f;
    float nonlin_ = 0.f;
    float buf_[1024] = {};
    size_t write_pos_ = 0, len_ = 110;
    float frac_delay_ = 0.f;
public:
    void Init(float sr) { sr_ = sr; Reset(); }
    void Reset() { for (size_t i = 0; i < 1024; i++) buf_[i] = 0.f; write_pos_ = 0; }
    void SetFreq(float f) {
        freq_ = fmaxf(f, 20.f);
        float d = sr_ / freq_;
        len_ = (size_t)fminf(d, 1023.f);
        if (len_ < 1) len_ = 1;
        frac_delay_ = d - (float)len_;
    }
    void SetBrightness(float b) { brightness_ = b; }
    void SetDamping(float d) { damping_ = d; }
    void SetNonLinearity(float n) { nonlin_ = n; }
    float Process(const float in) {
        buf_[write_pos_] = in;
        size_t read_pos = (write_pos_ + 1024 - len_) % 1024;
        size_t read_pos2 = (read_pos + 1) % 1024;
        float out = buf_[read_pos] * (1.f - frac_delay_) + buf_[read_pos2] * frac_delay_;
        float filtered = out * (0.5f + brightness_ * 0.5f);
        buf_[write_pos_] += filtered * (1.f - damping_ * 0.01f);
        write_pos_ = (write_pos_ + 1) % 1024;
        return out;
    }
};

class StringVoice {
    float sr_ = 48000.f, freq_ = 440.f, accent_ = 0.5f;
    float structure_ = 0.5f, brightness_ = 0.5f, damping_ = 0.5f;
    bool sustain_ = false;
    String string_;
    float env_ = 0.f, aux_ = 0.f;
    uint32_t noise_seed_ = 11111;
public:
    void Init(float sr) { sr_ = sr; string_.Init(sr); }
    void Trig() { env_ = 1.f; }
    void Reset() { string_.Reset(); }
    void SetSustain(bool s) { sustain_ = s; }
    void SetFreq(float f) { freq_ = f; string_.SetFreq(f); }
    void SetAccent(float a) { accent_ = a; }
    void SetStructure(float s) { structure_ = s; string_.SetNonLinearity(s < 0.26f ? s * 3.8f - 1.f : (s - 0.26f) / 0.74f); }
    void SetBrightness(float b) { brightness_ = b; string_.SetBrightness(b); }
    void SetDamping(float d) { damping_ = d; string_.SetDamping(d); }
    float GetAux() const { return aux_; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 0.997f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        float excitation = noise * env_ * accent_;
        if (sustain_) { noise_seed_ = noise_seed_ * 1664525u + 1013904223u; excitation += ((float)(int32_t)noise_seed_ / 2147483648.f) * 0.002f; }
        aux_ = excitation;
        return string_.Process(excitation);
    }
};

class ModalVoice {
    float sr_ = 48000.f, freq_ = 440.f, accent_ = 0.5f;
    float structure_ = 0.5f, brightness_ = 0.5f, damping_ = 0.5f;
    bool sustain_ = false;
    float env_ = 0.f, aux_ = 0.f;
    float d1_ = 0.f, d2_ = 0.f;
    uint32_t noise_seed_ = 22222;
public:
    void Init(float sr) { sr_ = sr; }
    void Trig() { env_ = 1.f; }
    void SetSustain(bool s) { sustain_ = s; }
    void SetFreq(float f) { freq_ = f; }
    void SetAccent(float a) { accent_ = a; }
    void SetStructure(float s) { structure_ = s; }
    void SetBrightness(float b) { brightness_ = b; }
    void SetDamping(float d) { damping_ = d; }
    float GetAux() const { return aux_; }
    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 0.997f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        float excitation = noise * env_ * accent_;
        aux_ = excitation;
        float f = 2.f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = 1.f / (1.f + (1.f - damping_) * 0.1f);
        float hp = excitation - q * d1_ - d2_;
        float bp = f * hp + d1_;
        float lp = f * bp + d2_;
        d1_ = bp; d2_ = lp;
        return bp * brightness_;
    }
};

class Resonator {
    float sr_ = 48000.f, freq_ = 440.f, structure_ = 0.5f;
    float brightness_ = 0.5f, damping_ = 0.5f;
    float d1_ = 0.f, d2_ = 0.f;
public:
    void Init(float position, int resolution, float sr) { sr_ = sr; (void)position; (void)resolution; }
    void SetFreq(float f) { freq_ = f; }
    void SetStructure(float s) { structure_ = s; }
    void SetBrightness(float b) { brightness_ = b; }
    void SetDamping(float d) { damping_ = d; }
    float Process(const float in) {
        float f = 2.f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = 1.f / (1.f + (1.f - damping_) * 0.1f);
        float hp = in - q * d1_ - d2_;
        float bp = f * hp + d1_;
        float lp = f * bp + d2_;
        d1_ = bp; d2_ = lp;
        return bp;
    }
};

class Drip {
    float sr_ = 48000.f;
    float env_ = 0.f;
    uint32_t noise_seed_ = 33333;
public:
    void Init(float sr, float dettack) { sr_ = sr; (void)dettack; }
    float Process(bool trig) {
        if (trig) env_ = 1.f;
        env_ *= 0.999f;
        noise_seed_ = noise_seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)noise_seed_ / 2147483648.f;
        return noise * env_ * env_ * 0.3f;
    }
};

// ===================== NOISE =====================

class WhiteNoise {
    float amp_ = 1.f;
    uint32_t seed_ = 1;
public:
    void Init() { seed_ = 1; }
    void SetAmp(float a) { amp_ = a; }
    void SetSeed(int32_t s) { seed_ = (s == 0) ? 1 : (uint32_t)s; }
    float Process() {
        seed_ = seed_ * 1664525u + 1013904223u;
        return ((float)(int32_t)seed_ / 2147483648.f) * amp_;
    }
};

class Dust {
    float density_ = 0.5f;
    uint32_t seed_ = 44444;
public:
    void Init() { density_ = 0.5f; }
    void SetDensity(float d) { density_ = d; }
    float Process() {
        seed_ = seed_ * 1664525u + 1013904223u;
        float r = (float)seed_ / 4294967296.f;
        if (r < density_ * 0.001f) {
            seed_ = seed_ * 1664525u + 1013904223u;
            return (float)(int32_t)seed_ / 2147483648.f;
        }
        return 0.f;
    }
};

// ===================== CONTROL =====================

class Adsr {
    float sr_ = 48000.f;
    float attack_ = 0.01f, decay_ = 0.1f, sustain_ = 0.7f, release_ = 0.3f;
    float value_ = 0.f, target_ = 0.f;
    uint8_t seg_ = 0; // IDLE
    bool running_ = false;
    int block_size_ = 1;
public:
    void Init(float sr, int blockSize = 1) { sr_ = sr; block_size_ = blockSize; }
    void SetTime(int seg, float time) {
        switch (seg) {
            case 1: attack_ = fmaxf(time, 0.001f); break;
            case 2: decay_ = fmaxf(time, 0.001f); break;
            case 4: release_ = fmaxf(time, 0.001f); break;
        }
    }
    void SetAttackTime(float t, float shape = 0.f) { attack_ = fmaxf(t, 0.001f); (void)shape; }
    void SetDecayTime(float t) { decay_ = fmaxf(t, 0.001f); }
    void SetReleaseTime(float t) { release_ = fmaxf(t, 0.001f); }
    void SetSustainLevel(float s) { sustain_ = s; }
    void Retrigger(bool hard) { if (hard) value_ = 0.f; seg_ = 1; running_ = true; }
    uint8_t GetCurrentSegment() const { return seg_; }
    bool IsRunning() const { return running_; }
    float Process(bool gate) {
        if (gate && seg_ == 0) { seg_ = 1; running_ = true; }
        if (!gate && (seg_ == 1 || seg_ == 2)) { seg_ = 4; }
        float rate;
        switch (seg_) {
            case 1: // attack
                rate = 1.f / (attack_ * sr_ / (float)block_size_);
                value_ += rate;
                if (value_ >= 1.f) { value_ = 1.f; seg_ = 2; }
                break;
            case 2: // decay
                rate = 1.f / (decay_ * sr_ / (float)block_size_);
                value_ -= rate;
                if (value_ <= sustain_) { value_ = sustain_; }
                break;
            case 4: // release
                rate = 1.f / (release_ * sr_ / (float)block_size_);
                value_ -= rate;
                if (value_ <= 0.f) { value_ = 0.f; seg_ = 0; running_ = false; }
                break;
            default:
                break;
        }
        return value_;
    }
};

class AdEnv {
    float sr_ = 48000.f;
    float attack_ = 0.01f, decay_ = 0.1f;
    float min_ = 0.f, max_ = 1.f, curve_ = 0.f;
    float value_ = 0.f;
    uint8_t seg_ = 0;
    bool running_ = false, triggered_ = false;
public:
    void Init(float sr) { sr_ = sr; }
    void Trigger() { triggered_ = true; seg_ = 1; running_ = true; }
    void SetTime(uint8_t seg, float time) {
        if (seg == 1) attack_ = fmaxf(time, 0.001f);
        else if (seg == 2) decay_ = fmaxf(time, 0.001f);
    }
    void SetCurve(float c) { curve_ = c; }
    void SetMin(float m) { min_ = m; }
    void SetMax(float m) { max_ = m; }
    float GetValue() const { return value_; }
    uint8_t GetCurrentSegment() const { return seg_; }
    bool IsRunning() const { return running_; }
    float Process() {
        float rate;
        switch (seg_) {
            case 1: // attack
                rate = 1.f / (attack_ * sr_);
                value_ += rate;
                if (value_ >= 1.f) { value_ = 1.f; seg_ = 2; }
                break;
            case 2: // decay
                rate = 1.f / (decay_ * sr_);
                value_ -= rate;
                if (value_ <= 0.f) { value_ = 0.f; seg_ = 0; running_ = false; }
                break;
            default:
                break;
        }
        return min_ + value_ * (max_ - min_);
    }
};

class Phasor {
    float sr_ = 48000.f, freq_ = 1.f, phase_ = 0.f;
public:
    void Init(float sr, float freq, float phase) { sr_ = sr; freq_ = freq; phase_ = phase; }
    void Init(float sr, float freq) { sr_ = sr; freq_ = freq; phase_ = 0.f; }
    void Init(float sr) { sr_ = sr; freq_ = 1.f; phase_ = 0.f; }
    void SetFreq(float f) { freq_ = f; }
    float GetFreq() const { return freq_; }
    float Process() {
        float out = phase_;
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) phase_ -= 1.f;
        if (phase_ < 0.f) phase_ += 1.f;
        return out;
    }
};

// ===================== DYNAMICS =====================

class CrossFade {
    float pos_ = 0.5f;
    int curve_ = 0;
public:
    void Init(int curve) { curve_ = curve; }
    void Init() { curve_ = 0; }
    void SetPos(float p) { pos_ = p; }
    void SetCurve(uint8_t c) { curve_ = c; }
    float Process(float& in1, float& in2) {
        return in1 * (1.f - pos_) + in2 * pos_;
    }
};

class Limiter {
public:
    void Init() {}
    void ProcessBlock(float* in, size_t size, float pre_gain) {
        for (size_t i = 0; i < size; i++) {
            in[i] *= pre_gain;
            if (in[i] > 1.f) in[i] = 1.f;
            if (in[i] < -1.f) in[i] = -1.f;
        }
    }
};

// ===================== UTILITY =====================

template<typename T, size_t max_size>
class DelayLine {
    T line_[max_size] = {};
    size_t write_pos_ = 0;
    size_t delay_ = max_size - 1;
    float frac_delay_ = 0.f;
    bool use_frac_ = false;
public:
    void Init() { Reset(); }
    void Reset() { for (size_t i = 0; i < max_size; i++) line_[i] = T(0); write_pos_ = 0; }
    void SetDelay(size_t d) { delay_ = (d < max_size) ? d : max_size - 1; use_frac_ = false; }
    void SetDelay(float d) {
        if (d < 0.f) d = 0.f;
        if (d >= (float)max_size) d = (float)(max_size - 1);
        delay_ = (size_t)d;
        frac_delay_ = d - (float)delay_;
        use_frac_ = true;
    }
    void Write(const T sample) {
        line_[write_pos_] = sample;
        write_pos_ = (write_pos_ + 1) % max_size;
    }
    const T Read() const {
        size_t pos = (write_pos_ + max_size - delay_) % max_size;
        if (use_frac_) {
            size_t pos2 = (pos + max_size - 1) % max_size;
            return line_[pos] * (1.f - frac_delay_) + line_[pos2] * frac_delay_;
        }
        return line_[pos];
    }
    const T Read(float d) const {
        size_t di = (size_t)d;
        float frac = d - (float)di;
        size_t pos1 = (write_pos_ + max_size - di) % max_size;
        size_t pos2 = (pos1 + max_size - 1) % max_size;
        return line_[pos1] * (1.f - frac) + line_[pos2] * frac;
    }
    const T ReadHermite(float d) const {
        return Read(d); // Simplified: use linear interp
    }
    const T Allpass(const T sample, size_t d, const T coefficient) {
        T read_val = line_[(write_pos_ + max_size - d) % max_size];
        T out = read_val + coefficient * (sample - read_val);
        Write(sample);
        return out;
    }
};

class Metro {
    float freq_ = 1.f, sr_ = 48000.f, phase_ = 0.f;
public:
    void Init(float freq, float sr) { freq_ = freq; sr_ = sr; phase_ = 0.f; }
    void SetFreq(float f) { freq_ = f; }
    void Reset() { phase_ = 0.f; }
    uint8_t Process() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) { phase_ -= 1.f; return 1; }
        return 0;
    }
};

class Maytrig {
    uint32_t seed_ = 55555;
public:
    float Process(float prob) {
        seed_ = seed_ * 1664525u + 1013904223u;
        float r = (float)seed_ / 4294967296.f;
        return (r < prob) ? 1.f : 0.f;
    }
};

class SampleHold {
    float held_ = 0.f;
public:
    float Process(bool trigger, float input, int mode = 0) {
        if (mode == 0) { // sample & hold
            if (trigger) held_ = input;
        } else { // track & hold
            if (!trigger) held_ = input;
        }
        return held_;
    }
};

class SmoothRandomGenerator {
    float sr_ = 48000.f, freq_ = 1.f, phase_ = 0.f;
    float current_ = 0.f, next_ = 0.f;
    uint32_t seed_ = 66666;
    float NewRandom() { seed_ = seed_ * 1664525u + 1013904223u; return (float)(int32_t)seed_ / 2147483648.f; }
public:
    void Init(float sr) { sr_ = sr; current_ = NewRandom(); next_ = NewRandom(); }
    void SetFreq(float f) { freq_ = f; }
    float Process() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.f) { phase_ -= 1.f; current_ = next_; next_ = NewRandom(); }
        // Smoothstep interpolation
        float t = phase_ * phase_ * (3.f - 2.f * phase_);
        return current_ + t * (next_ - current_);
    }
};

} // namespace daisysp

// Forward declaration for GPIO write
struct dsy_gpio {
    bool state = false;
};
inline void dsy_gpio_write(dsy_gpio* gpio, bool val) { gpio->state = val; }

// ─── DaisyPatchSM stub ──────────────────────────────────────────
// Patch Submodule: 12 ADC, 2 CV out, 2 gate in, 2 gate out, stereo audio, 12 GPIO
namespace daisy {
namespace patch_sm {

// CV input channel enums (matching libDaisy's DaisyPatchSM)
enum {
    CV_1 = 0, CV_2, CV_3, CV_4,
    CV_5, CV_6, CV_7, CV_8,
    ADC_9, ADC_10, ADC_11, ADC_12,
    ADC_LAST
};

// Physical pin aliases (Patch SM carrier board header pins)
static constexpr int C5  = CV_1;   // 0
static constexpr int C4  = CV_2;   // 1
static constexpr int C3  = CV_3;   // 2
static constexpr int C2  = CV_4;   // 3
static constexpr int C6  = CV_5;   // 4
static constexpr int C7  = CV_6;   // 5
static constexpr int C8  = CV_7;   // 6
static constexpr int C9  = CV_8;   // 7
static constexpr int C10 = ADC_9;  // 8

// CV output channel enums
enum {
    CV_OUT_1 = 1,
    CV_OUT_2 = 2,
    CV_OUT_BOTH = 0
};

struct GateIn {
    bool trig = false;
    bool Trig() { bool t = trig; trig = false; return t; }
    bool State() const { return trig; }
};

class DaisyPatchSM {
public:
    GateIn gate_in_1;
    GateIn gate_in_2;
    dsy_gpio gate_out_1;
    dsy_gpio gate_out_2;
    dsy_gpio user_led;

    void Init() {
        for (int i = 0; i < 8; i++) controls_[i] = daisy_knob[i];
        for (int i = 0; i < 4; i++) controls_[i + 8] = daisy_cv_in[i];
        gate_in_1.trig = daisy_gate[0];
        gate_in_2.trig = daisy_gate[1];
    }

    void ProcessAllControls() {
        ProcessAnalogControls();
        ProcessDigitalControls();
    }

    void ProcessAnalogControls() {
        for (int i = 0; i < 8; i++) controls_[i] = daisy_knob[i];
        for (int i = 0; i < 4; i++) controls_[i + 8] = daisy_cv_in[i];
    }

    void ProcessDigitalControls() {
        gate_in_1.trig = daisy_gate[0];
        gate_in_2.trig = daisy_gate[1];
    }

    float GetAdcValue(int idx) const {
        if (idx >= 0 && idx < 12) return controls_[idx];
        return 0.f;
    }

    void StartAdc() {}
    void StopAdc() {}
    void StartDac(void* cb = nullptr) { (void)cb; }
    void StopDac() {}

    void WriteCvOut(int channel, float voltage) {
        (void)channel; (void)voltage; // No-op in browser
    }

    void SetLed(bool state) { user_led.state = state; }

    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    float AudioCallbackRate() const { return daisy_sample_rate / 48.f; }
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                              daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}

private:
    float controls_[12] = {};
};

} // namespace patch_sm
} // namespace daisy

// Bring patch_sm types into scope for user code
using daisy::patch_sm::DaisyPatchSM;
using daisy::patch_sm::GateIn;

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
        if (idx >= 0 && idx < 8) return daisy_knob[idx];
        return 0.5f;
    }

    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAdc() {}
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                             daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}

    // Display stub (for DaisyPatch OLED)
    struct Display {
        void Fill(bool on) { (void)on; }
        void SetCursor(int x, int y) { (void)x; (void)y; }
        void WriteString(const char* str, int font, bool on) { (void)str; (void)font; (void)on; }
        void Update() {}
    } display;

    void DisplayControls(bool invert) { (void)invert; }

    struct Seed {
        struct DacHandle {
            enum Channel { ONE = 0, TWO = 1, BOTH = 2 };
            void WriteValue(Channel ch, uint16_t val) { (void)ch; (void)val; }
        } dac;
    } seed;
};

// ─── DaisySeed stub ─────────────────────────────────────────────
namespace daisy {

struct DacHandle {
    enum Channel { ONE = 0, TWO = 1, BOTH = 2 };
    void WriteValue(Channel ch, uint16_t val) { (void)ch; (void)val; }
};

struct AdcChannelConfig {
    void InitSingle(int pin) { (void)pin; }
};

struct AdcHandle {
    void Init(AdcChannelConfig* cfg, int num) { (void)cfg; (void)num; }
    void Start() {}
    float GetFloat(int ch) const { return (ch >= 0 && ch < 8) ? daisy_knob[ch] : 0.f; }
};

class DaisySeed {
public:
    AdcHandle adc;
    DacHandle dac;

    void Init() {}
    int GetPin(int pin) const { return pin; }
    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                              daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}
};

} // namespace daisy
using daisy::DaisySeed;

// ─── DaisyPod stub ──────────────────────────────────────────────
struct DaisyPod {
    struct Knob {
        float val = 0.5f;
        void Process() {}
        float Value() const { return val; }
    } knob1, knob2;

    struct Button {
        bool pressed_ = false;
        bool rising_ = false;
        bool Pressed() const { return pressed_; }
        bool RisingEdge() { bool r = rising_; rising_ = false; return r; }
        bool FallingEdge() { return false; }
    } button1, button2;

    struct Encoder {
        int inc_ = 0;
        bool rising_ = false;
        int Increment() { int i = inc_; inc_ = 0; return i; }
        bool RisingEdge() { bool r = rising_; rising_ = false; return r; }
        bool Pressed() const { return false; }
    } encoder;

    struct Led {
        float r = 0.f, g = 0.f, b = 0.f;
        void Set(float r_, float g_, float b_) { r = r_; g = g_; b = b_; }
    } led1, led2;

    void Init() {
        knob1.val = daisy_knob[0];
        knob2.val = daisy_knob[1];
    }

    void ProcessAllControls() {
        knob1.val = daisy_knob[0];
        knob2.val = daisy_knob[1];
    }

    void UpdateLeds() {}
    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                              daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}
};

// ─── DaisyPetal stub ────────────────────────────────────────────
struct DaisyPetal {
    struct Knob {
        float val = 0.5f;
        void Process() {}
        float Value() const { return val; }
    } knob[6];

    struct Switch {
        bool state_ = false;
        bool rising_ = false;
        bool Pressed() const { return state_; }
        bool RisingEdge() { bool r = rising_; rising_ = false; return r; }
        bool FallingEdge() { return false; }
    } switches[4];

    struct Encoder {
        int inc_ = 0;
        bool rising_ = false;
        int Increment() { int i = inc_; inc_ = 0; return i; }
        bool RisingEdge() { bool r = rising_; rising_ = false; return r; }
        bool Pressed() const { return false; }
    } encoder;

    void Init() {
        for (int i = 0; i < 6; i++) knob[i].val = (i < 8) ? daisy_knob[i] : 0.5f;
    }

    void ProcessAllControls() {
        for (int i = 0; i < 6; i++) {
            knob[i].val = (i < 8) ? daisy_knob[i] : 0.5f;
        }
    }

    void SetRingLed(int index, float r, float g, float b) {
        (void)index; (void)r; (void)g; (void)b;
    }
    void SetFootswitchLed(int index, float brightness) {
        (void)index; (void)brightness;
    }
    void UpdateLeds() {}
    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                              daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}
};

// ─── DaisyField stub ────────────────────────────────────────────
// Font stub
struct FontDef {
    int width;
    int height;
};
static const FontDef Font_7x10 = {7, 10};
static const FontDef Font_6x8 = {6, 8};
static const FontDef Font_11x18 = {11, 18};
static const FontDef Font_16x26 = {16, 26};

struct DaisyField {
    struct Knob {
        float val = 0.5f;
        void Process() {}
        float Value() const { return val; }
    } knob[8];

    struct Display {
        void Fill(bool on) { (void)on; }
        void SetCursor(int x, int y) { (void)x; (void)y; }
        void WriteString(const char* str, FontDef font, bool on) {
            (void)str; (void)font; (void)on;
        }
        void Update() {}
    } display;

    struct LedDriver {
        void SetLed(int index, float brightness) { (void)index; (void)brightness; }
    } led_driver;

    struct Seed {
        daisy::DacHandle dac;
    } seed;

    bool keyboard_state_[16] = {};
    bool keyboard_rising_[16] = {};
    bool keyboard_falling_[16] = {};

    void Init() {
        for (int i = 0; i < 8; i++) knob[i].val = daisy_knob[i];
    }

    void ProcessAllControls() {
        for (int i = 0; i < 8; i++) knob[i].val = daisy_knob[i];
    }

    bool KeyboardState(int key) const {
        return (key >= 0 && key < 16) ? keyboard_state_[key] : false;
    }
    bool KeyboardRisingEdge(int key) {
        if (key >= 0 && key < 16) { bool r = keyboard_rising_[key]; keyboard_rising_[key] = false; return r; }
        return false;
    }
    bool KeyboardFallingEdge(int key) {
        if (key >= 0 && key < 16) { bool f = keyboard_falling_[key]; keyboard_falling_[key] = false; return f; }
        return false;
    }

    void UpdateLeds() {}
    void SetAudioBlockSize(int) {}
    float AudioSampleRate() const { return daisy_sample_rate; }
    void StartAudio(void (*)(daisy::AudioHandle::InputBuffer,
                              daisy::AudioHandle::OutputBuffer, size_t)) {}
    void StartAudio(void (*)(float**, float**, size_t)) {}
};
