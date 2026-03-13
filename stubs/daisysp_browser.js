// Header-only DaisySP for in-browser C++ compilation
// Each entry: VFS path → C++ header content
// Tier 1: Oscillator, Svf, Adsr, AdEnv, Phasor, DcBlock, Metro
// Plus already header-only: DelayLine, WhiteNoise, Dust, OnePole, etc.

export const DAISYSP_HEADERS = new Map([

// ─── daisy_patch.h — Browser hardware stub ──────────────────────────
['daisy_patch.h', `#pragma once
#include <cstddef>
#include <cstdint>
#include <cmath>

#define DSY_SDRAM_BSS

namespace daisy {
  namespace AudioHandle {
    using InputBuffer = const float* const*;
    using OutputBuffer = float**;
  }
}

extern "C" {
  extern float daisy_knob[4];
  extern bool  daisy_gate[2];
  extern float daisy_sample_rate;
  extern float daisy_pitch_cv;
  extern float daisy_velocity;
  extern float daisy_pitchbend;
  extern float daisy_cv_in[4];
}

inline float cvToFreq(float cv) {
    return 440.0f * powf(2.0f, cv - 0.75f);
}

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
        bool state = false;
        bool trig_ = false;
        bool Trig() { bool t = trig_; trig_ = false; return t; }
        bool State() const { return state; }
    } gate_input[2];

    void Init() {
        for (int i = 0; i < 4; i++) controls[i].value = daisy_knob[i];
        for (int i = 0; i < 2; i++) { gate_input[i].state = daisy_gate[i]; gate_input[i].trig_ = daisy_gate[i]; }
    }

    void ProcessAllControls() {
        for (int i = 0; i < 4; i++) controls[i].value = daisy_knob[i];
        for (int i = 0; i < 2; i++) { gate_input[i].state = daisy_gate[i]; gate_input[i].trig_ = daisy_gate[i]; }
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
`],

// ─── daisysp.h — Top-level include ─────────────────────────────────
['daisysp.h', `#pragma once
#include "Utility/dsp.h"
#include "Synthesis/oscillator.h"
#include "Synthesis/harmonic_osc.h"
#include "Synthesis/fm2.h"
#include "Filters/svf.h"
#include "Filters/ladder.h"
#include "Filters/onepole.h"
#include "Filters/soap.h"
#include "Control/adsr.h"
#include "Control/adenv.h"
#include "Control/phasor.h"
#include "Utility/dcblock.h"
#include "Utility/metro.h"
#include "Utility/delayline.h"
#include "Utility/maytrig.h"
#include "Utility/samplehold.h"
#include "Utility/smooth_random.h"
#include "Noise/whitenoise.h"
#include "Noise/dust.h"
#include "Noise/clockednoise.h"
#include "Noise/fractal_noise.h"
#include "Effects/overdrive.h"
#include "Effects/decimator.h"
#include "Effects/sampleratereducer.h"
#include "Effects/wavefolder.h"
#include "Effects/tremolo.h"
#include "Effects/pitchshifter.h"
#include "Drums/analogbassdrum.h"
#include "Drums/analogsnaredrum.h"
#include "Drums/synthbassdrum.h"
#include "Drums/synthsnaredrum.h"
#include "Drums/hihat.h"
#include "PhysicalModeling/KarplusString.h"
#include "PhysicalModeling/stringvoice.h"
#include "PhysicalModeling/modalvoice.h"
#include "PhysicalModeling/resonator.h"
#include "PhysicalModeling/drip.h"
#include "Dynamics/crossfade.h"
#include "Dynamics/limiter.h"
#include "Sampling/granularplayer.h"
`],

// ─── Utility/dsp.h — Core utility functions ─────────────────────────
['Utility/dsp.h', `#pragma once
#include <cmath>
#include <cstdint>

#ifndef PI_F
#define PI_F 3.14159265358979f
#endif
#ifndef TWOPI_F
#define TWOPI_F 6.28318530717959f
#endif
#ifndef HALFPI_F
#define HALFPI_F 1.57079632679490f
#endif

namespace daisysp {

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
    if (!isfinite(x)) x = y;
}

} // namespace daisysp
`],

// ─── Synthesis/oscillator.h — Multi-waveform oscillator ─────────────
['Synthesis/oscillator.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

namespace daisysp {

class Oscillator {
  public:
    enum {
        WAVE_SIN,
        WAVE_TRI,
        WAVE_SAW,
        WAVE_RAMP,
        WAVE_SQUARE,
        WAVE_POLYBLEP_TRI,
        WAVE_POLYBLEP_SAW,
        WAVE_POLYBLEP_SQUARE,
        WAVE_LAST,
    };

    void Init(float sample_rate) {
        sr_        = sample_rate;
        sr_recip_  = 1.0f / sample_rate;
        freq_      = 440.0f;
        amp_       = 0.5f;
        pw_        = 0.5f;
        phase_     = 0.0f;
        phase_inc_ = freq_ * sr_recip_;
        waveform_  = WAVE_SIN;
        eoc_       = true;
        eor_       = true;
        last_out_  = 0.0f;
    }

    float Process() {
        float out, t;
        switch (waveform_) {
            case WAVE_SIN:
                out = sinf(phase_ * TWOPI_F) * amp_;
                break;
            case WAVE_TRI:
                t = -1.0f + (2.0f * phase_);
                out = 2.0f * (fabsf(t) - 0.5f) * amp_;
                break;
            case WAVE_SAW:
                out = (-1.0f * (1.0f - (2.0f * phase_))) * amp_;
                break;
            case WAVE_RAMP:
                out = ((2.0f * phase_) - 1.0f) * amp_;
                break;
            case WAVE_SQUARE:
                out = (phase_ < pw_ ? 1.0f : -1.0f) * amp_;
                break;
            case WAVE_POLYBLEP_TRI: {
                t = phase_;
                out = (t < 0.5f) ? 1.0f : -1.0f;
                out += Polyblep(t);
                out -= Polyblep(fmodf(t + 0.5f, 1.0f));
                out = phase_inc_ * out + (1.0f - phase_inc_) * last_out_;
                last_out_ = out;
                out *= amp_;
                break;
            }
            case WAVE_POLYBLEP_SAW:
                t = phase_;
                out = (2.0f * t) - 1.0f;
                out -= Polyblep(t);
                out *= amp_;
                break;
            case WAVE_POLYBLEP_SQUARE:
                t = phase_;
                out = (t < pw_) ? 1.0f : -1.0f;
                out += Polyblep(t);
                out -= Polyblep(fmodf(t + (1.0f - pw_), 1.0f));
                out *= amp_;
                break;
            default:
                out = 0.0f;
                break;
        }

        phase_ += phase_inc_;
        if (phase_ > 1.0f) { phase_ -= 1.0f; eoc_ = true; }
        else { eoc_ = false; }
        eor_ = (phase_ - phase_inc_ < 0.5f && phase_ >= 0.5f);

        return out;
    }

    void SetFreq(float f)       { freq_ = f; phase_inc_ = f * sr_recip_; }
    void SetAmp(float a)        { amp_ = a; }
    void SetWaveform(uint8_t w) { waveform_ = w < WAVE_LAST ? w : WAVE_SIN; }
    void SetPw(float pw)        { pw_ = fclamp(pw, 0.0f, 1.0f); }

    void PhaseAdd(float p) {
        phase_ += p;
        while (phase_ > 1.0f) phase_ -= 1.0f;
        while (phase_ < 0.0f) phase_ += 1.0f;
    }

    void Reset(float p = 0.0f)     { phase_ = p; }
    bool IsEOR() const              { return eor_; }
    bool IsEOC() const              { return eoc_; }
    bool IsRising() const           { return phase_ < 0.5f; }
    bool IsFalling() const          { return phase_ >= 0.5f; }

  private:
    float Polyblep(float t) {
        float dt = phase_inc_;
        if (t < dt) {
            t /= dt;
            return t + t - t * t - 1.0f;
        } else if (t > 1.0f - dt) {
            t = (t - 1.0f) / dt;
            return t * t + t + t + 1.0f;
        }
        return 0.0f;
    }

    float   sr_, sr_recip_, freq_, amp_, pw_;
    float   phase_, phase_inc_;
    uint8_t waveform_;
    bool    eoc_, eor_;
    float   last_out_;
};

} // namespace daisysp
`],

// ─── Synthesis/harmonic_osc.h — Chebyshev harmonic oscillator ───────
['Synthesis/harmonic_osc.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

template <int num_harmonics = 16>
class HarmonicOscillator {
  public:
    void Init(float sample_rate) {
        sample_rate_ = sample_rate;
        phase_       = 0.0f;
        frequency_   = 440.0f;
        first_harm_  = 1;
        for (int i = 0; i < num_harmonics; i++) amplitudes_[i] = 0.0f;
        amplitudes_[0] = 1.0f;
        recalc_ = true;
    }

    float Process() {
        float phase_inc = frequency_ / sample_rate_;
        phase_ += phase_inc;
        if (phase_ >= 1.0f) phase_ -= 1.0f;

        float x = cosf(phase_ * TWOPI_F);
        float Tn_1 = x;
        float Tn_2 = 1.0f;
        float out = amplitudes_[0] * Tn_1;

        for (int i = 1; i < num_harmonics; i++) {
            float Tn = 2.0f * x * Tn_1 - Tn_2;
            out += amplitudes_[i] * Tn;
            Tn_2 = Tn_1;
            Tn_1 = Tn;
        }
        return out;
    }

    void SetFreq(float freq)                     { frequency_ = freq; }
    void SetFirstHarmIdx(int idx)                 { first_harm_ = idx > 0 ? idx : 1; }
    void SetAmplitudes(const float* amplitudes)   { for (int i = 0; i < num_harmonics; i++) amplitudes_[i] = amplitudes[i]; }
    void SetSingleAmp(float amp, int idx)         { if (idx >= 0 && idx < num_harmonics) amplitudes_[idx] = amp; }

  private:
    float sample_rate_;
    float phase_;
    float frequency_;
    float amplitudes_[num_harmonics];
    int   first_harm_;
    bool  recalc_;
};

} // namespace daisysp
`],

// ─── Filters/svf.h — State Variable Filter ──────────────────────────
['Filters/svf.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class Svf {
  public:
    void Init(float sample_rate) {
        sr_        = sample_rate;
        fc_        = 200.0f;
        res_       = 0.5f;
        drive_     = 0.0f;
        notch_     = 0.0f;
        low_       = 0.0f;
        high_      = 0.0f;
        band_      = 0.0f;
        peak_      = 0.0f;
        out_notch_ = 0.0f;
        out_low_   = 0.0f;
        out_high_  = 0.0f;
        out_band_  = 0.0f;
        out_peak_  = 0.0f;
    }

    void Process(float in) {
        float drv = in;
        if (drive_ > 0.0f) {
            drv *= (1.0f + drive_);
            drv = fclamp(drv, -1.0f, 1.0f);
        }

        float freq = 2.0f * sinf(PI_F * fminf(fc_ / sr_, 0.25f));
        float damp = fminf(2.0f * (1.0f - powf(res_, 0.25f)),
                           fminf(2.0f, 2.0f / freq - freq * 0.5f));

        // Two passes for double-sampling stability
        for (int i = 0; i < 2; i++) {
            notch_ = drv - damp * band_;
            low_   = low_ + freq * band_;
            high_  = notch_ - low_;
            band_  = freq * high_ + band_;
        }

        out_low_   = low_;
        out_high_  = high_;
        out_band_  = band_;
        out_notch_ = notch_;
        out_peak_  = low_ - high_;
    }

    void SetFreq(float f)  { fc_    = fclamp(f, 1.0f, sr_ / 3.0f); }
    void SetRes(float r)   { res_   = fclamp(r, 0.0f, 1.0f); }
    void SetDrive(float d) { drive_ = fclamp(d, 0.0f, 1.0f); }

    float Low()   const { return out_low_; }
    float High()  const { return out_high_; }
    float Band()  const { return out_band_; }
    float Notch() const { return out_notch_; }
    float Peak()  const { return out_peak_; }

  private:
    float sr_, fc_, res_, drive_;
    float notch_, low_, high_, band_, peak_;
    float out_notch_, out_low_, out_high_, out_band_, out_peak_;
};

} // namespace daisysp
`],

// ─── Filters/onepole.h — Lightweight 1-pole filter ──────────────────
['Filters/onepole.h', `#pragma once
#include <cmath>

namespace daisysp {

enum FilterMode {
    FILTER_MODE_LOW_PASS,
    FILTER_MODE_HIGH_PASS,
};

class OnePole {
  public:
    void Init() {
        frequency_ = 0.0f;
        mode_      = FILTER_MODE_LOW_PASS;
        a0_        = 1.0f;
        b1_        = 0.0f;
        yn1_       = 0.0f;
    }

    float Process(float in) {
        yn1_ = in * a0_ + yn1_ * b1_;
        if (mode_ == FILTER_MODE_HIGH_PASS) return in - yn1_;
        return yn1_;
    }

    void ProcessBlock(float* in_out, size_t size) {
        for (size_t i = 0; i < size; i++) in_out[i] = Process(in_out[i]);
    }

    void SetFrequency(float freq) {
        frequency_ = freq;
        b1_        = expf(-2.0f * PI_F * freq);
        a0_        = 1.0f - b1_;
    }

    void SetFilterMode(FilterMode mode) { mode_ = mode; }
    void Reset() { yn1_ = 0.0f; }

  private:
    float      frequency_;
    float      a0_, b1_, yn1_;
    FilterMode mode_;
};

} // namespace daisysp
`],

// ─── Control/adsr.h — ADSR envelope ────────────────────────────────
['Control/adsr.h', `#pragma once
#include <cstdint>

namespace daisysp {

enum AdsrSeg {
    ADSR_SEG_IDLE    = 0,
    ADSR_SEG_ATTACK  = 1,
    ADSR_SEG_DECAY   = 2,
    ADSR_SEG_RELEASE = 4,
};

class Adsr {
  public:
    void Init(float sample_rate, int blockSize = 1) {
        sr_          = sample_rate;
        attackTime_  = 0.1f;
        decayTime_   = 0.1f;
        releaseTime_ = 0.1f;
        susLevel_    = 0.7f;
        output_      = 0.0f;
        segment_     = ADSR_SEG_IDLE;
        attackShape_ = 0.0f;
        gateState_   = false;
    }

    float Process(bool gate) {
        if (gate && !gateState_)  segment_ = ADSR_SEG_ATTACK;
        if (!gate && gateState_)  segment_ = ADSR_SEG_RELEASE;
        gateState_ = gate;

        float rate;
        switch (segment_) {
            case ADSR_SEG_ATTACK:
                rate = 1.0f / (attackTime_ * sr_ + 1.0f);
                output_ += (1.0f + attackShape_ - output_) * rate;
                if (output_ >= 1.0f) {
                    output_  = 1.0f;
                    segment_ = ADSR_SEG_DECAY;
                }
                break;
            case ADSR_SEG_DECAY:
                rate = 1.0f / (decayTime_ * sr_ + 1.0f);
                output_ += (susLevel_ - output_) * rate;
                break;
            case ADSR_SEG_RELEASE:
                rate = 1.0f / (releaseTime_ * sr_ + 1.0f);
                output_ += (0.0f - output_) * rate;
                if (output_ <= 0.001f) {
                    output_  = 0.0f;
                    segment_ = ADSR_SEG_IDLE;
                }
                break;
            default:
                output_ = 0.0f;
                break;
        }
        return output_;
    }

    void SetTime(int seg, float time) {
        switch (seg) {
            case ADSR_SEG_ATTACK:  attackTime_  = time; break;
            case ADSR_SEG_DECAY:   decayTime_   = time; break;
            case ADSR_SEG_RELEASE: releaseTime_ = time; break;
        }
    }

    void SetAttackTime(float t, float shape = 0.0f)  { attackTime_ = t; attackShape_ = shape; }
    void SetDecayTime(float t)                        { decayTime_ = t; }
    void SetReleaseTime(float t)                      { releaseTime_ = t; }
    void SetSustainLevel(float s)                     { susLevel_ = s; }
    void Retrigger(bool hard)                         { segment_ = ADSR_SEG_ATTACK; if (hard) output_ = 0.0f; }
    uint8_t GetCurrentSegment() const                 { return segment_; }
    bool IsRunning() const                            { return segment_ != ADSR_SEG_IDLE; }

  private:
    float   sr_;
    float   attackTime_, decayTime_, releaseTime_, susLevel_;
    float   output_, attackShape_;
    uint8_t segment_;
    bool    gateState_;
};

} // namespace daisysp
`],

// ─── Control/adenv.h — AD envelope ─────────────────────────────────
['Control/adenv.h', `#pragma once
#include <cmath>
#include <cstdint>

namespace daisysp {

enum AdEnvSeg {
    ADENV_SEG_IDLE,
    ADENV_SEG_ATTACK,
    ADENV_SEG_DECAY,
    ADENV_SEG_LAST,
};

class AdEnv {
  public:
    void Init(float sample_rate) {
        sr_      = sample_rate;
        min_     = 0.0f;
        max_     = 1.0f;
        output_  = 0.0f;
        curve_   = 0.0f;
        phase_   = 0;
        segment_ = ADENV_SEG_IDLE;
        for (int i = 0; i < ADENV_SEG_LAST; i++) {
            time_[i]    = 0.1f;
            samples_[i] = (uint32_t)(0.1f * sample_rate);
        }
    }

    float Process() {
        uint32_t target;
        switch (segment_) {
            case ADENV_SEG_ATTACK:
                target = samples_[ADENV_SEG_ATTACK];
                if (phase_ < target) {
                    float t = (float)phase_ / (float)target;
                    if (curve_ > 0.0f) t = powf(t, 1.0f + curve_ * 0.02f);
                    else if (curve_ < 0.0f) t = 1.0f - powf(1.0f - t, 1.0f - curve_ * 0.02f);
                    output_ = min_ + (max_ - min_) * t;
                    phase_++;
                } else {
                    output_ = max_;
                    segment_ = ADENV_SEG_DECAY;
                    phase_   = 0;
                }
                break;
            case ADENV_SEG_DECAY:
                target = samples_[ADENV_SEG_DECAY];
                if (phase_ < target) {
                    float t = (float)phase_ / (float)target;
                    if (curve_ > 0.0f) t = powf(t, 1.0f + curve_ * 0.02f);
                    else if (curve_ < 0.0f) t = 1.0f - powf(1.0f - t, 1.0f - curve_ * 0.02f);
                    output_ = max_ + (min_ - max_) * t;
                    phase_++;
                } else {
                    output_  = min_;
                    segment_ = ADENV_SEG_IDLE;
                    phase_   = 0;
                }
                break;
            default:
                output_ = min_;
                break;
        }
        return output_;
    }

    void Trigger() {
        segment_ = ADENV_SEG_ATTACK;
        phase_   = 0;
    }

    void SetTime(uint8_t seg, float time) {
        if (seg < ADENV_SEG_LAST) {
            time_[seg]    = time;
            samples_[seg] = (uint32_t)(time * sr_);
        }
    }

    void SetCurve(float c)        { curve_ = c; }
    void SetMin(float mn)         { min_ = mn; }
    void SetMax(float mx)         { max_ = mx; }
    float GetValue() const        { return output_; }
    uint8_t GetCurrentSegment()   { return segment_; }
    bool IsRunning() const        { return segment_ != ADENV_SEG_IDLE; }

  private:
    float    sr_, min_, max_, output_, curve_;
    float    time_[ADENV_SEG_LAST];
    uint32_t samples_[ADENV_SEG_LAST];
    uint32_t phase_;
    uint8_t  segment_;
};

} // namespace daisysp
`],

// ─── Control/phasor.h — 0-to-1 ramp ────────────────────────────────
['Control/phasor.h', `#pragma once

namespace daisysp {

class Phasor {
  public:
    void Init(float sample_rate, float freq, float initial_phase) {
        sr_    = sample_rate;
        freq_  = freq;
        inc_   = freq / sample_rate;
        phase_ = initial_phase;
    }
    void Init(float sample_rate, float freq) { Init(sample_rate, freq, 0.0f); }
    void Init(float sample_rate)             { Init(sample_rate, 1.0f, 0.0f); }

    float Process() {
        float out = phase_;
        phase_ += inc_;
        if (phase_ > 1.0f) phase_ -= 1.0f;
        if (phase_ < 0.0f) phase_ += 1.0f;
        return out;
    }

    void  SetFreq(float freq)   { freq_ = freq; inc_ = freq / sr_; }
    float GetFreq() const       { return freq_; }

  private:
    float sr_, freq_, inc_, phase_;
};

} // namespace daisysp
`],

// ─── Utility/dcblock.h — DC offset removal ──────────────────────────
['Utility/dcblock.h', `#pragma once

namespace daisysp {

class DcBlock {
  public:
    void Init(float sample_rate) {
        output_ = 0.0f;
        input_  = 0.0f;
    }

    float Process(float in) {
        float out = in - input_ + 0.995f * output_;
        input_  = in;
        output_ = out;
        return out;
    }

  private:
    float output_, input_;
};

} // namespace daisysp
`],

// ─── Utility/metro.h — Clock trigger ────────────────────────────────
['Utility/metro.h', `#pragma once

namespace daisysp {

class Metro {
  public:
    void Init(float freq, float sample_rate) {
        freq_ = freq;
        phs_  = 0.0f;
        inc_  = freq / sample_rate;
        sr_   = sample_rate;
    }

    uint8_t Process() {
        phs_ += inc_;
        if (phs_ >= 1.0f) {
            phs_ -= 1.0f;
            return 1;
        }
        return 0;
    }

    void  SetFreq(float freq) { freq_ = freq; inc_ = freq / sr_; }
    void  Reset()             { phs_ = 0.0f; }

  private:
    float   freq_, phs_, inc_, sr_;
};

} // namespace daisysp
`],

// ─── Utility/delayline.h — Templated delay line ─────────────────────
['Utility/delayline.h', `#pragma once
#include <cmath>
#include <cstddef>

namespace daisysp {

template <typename T, size_t max_size>
class DelayLine {
  public:
    void Init() { Reset(); }

    void Reset() {
        for (size_t i = 0; i < max_size; i++) line_[i] = T(0);
        write_ptr_ = 0;
        delay_     = 1;
    }

    void SetDelay(size_t delay) {
        delay_ = delay < max_size ? delay : max_size - 1;
    }

    void SetDelay(float delay) {
        int32_t d = (int32_t)delay;
        frac_  = delay - (float)d;
        delay_ = d < (int32_t)max_size ? d : max_size - 1;
    }

    void Write(const T sample) {
        line_[write_ptr_] = sample;
        write_ptr_ = (write_ptr_ - 1 + max_size) % max_size;
    }

    const T Read() const {
        T a = line_[(write_ptr_ + delay_) % max_size];
        T b = line_[(write_ptr_ + delay_ + 1) % max_size];
        return a + (b - a) * frac_;
    }

    const T Read(float delay) const {
        int32_t d = (int32_t)delay;
        float   f = delay - (float)d;
        T a = line_[(write_ptr_ + d) % max_size];
        T b = line_[(write_ptr_ + d + 1) % max_size];
        return a + (b - a) * f;
    }

    const T ReadHermite(float delay) const {
        int32_t d  = (int32_t)delay;
        float   f  = delay - (float)d;
        size_t  i0 = (write_ptr_ + d - 1 + max_size) % max_size;
        size_t  i1 = (write_ptr_ + d) % max_size;
        size_t  i2 = (write_ptr_ + d + 1) % max_size;
        size_t  i3 = (write_ptr_ + d + 2) % max_size;
        T xm1 = line_[i0], x0 = line_[i1], x1 = line_[i2], x2 = line_[i3];
        T c = (x1 - xm1) * 0.5f;
        T v = x0 - x1;
        T w = c + v;
        T a = w + v + (x2 - x0) * 0.5f;
        T b = w + a;
        return ((a * f - b) * f + c) * f + x0;
    }

    const T Allpass(const T sample, size_t delay, const T coeff) {
        T read = line_[(write_ptr_ + delay) % max_size];
        T write = sample + read * coeff;
        line_[write_ptr_] = write;
        write_ptr_ = (write_ptr_ - 1 + max_size) % max_size;
        return read - write * coeff;
    }

  private:
    T      line_[max_size];
    size_t write_ptr_;
    size_t delay_;
    float  frac_ = 0.0f;
};

} // namespace daisysp
`],

// ─── Utility/maytrig.h — Probabilistic trigger ─────────────────────
['Utility/maytrig.h', `#pragma once
#include <cstdlib>

namespace daisysp {

class Maytrig {
  public:
    float Process(float prob) {
        float r = (float)rand() / (float)RAND_MAX;
        return (r <= prob) ? 1.0f : 0.0f;
    }
};

} // namespace daisysp
`],

// ─── Utility/samplehold.h — Sample & Hold ───────────────────────────
['Utility/samplehold.h', `#pragma once

namespace daisysp {

enum SHMode {
    MODE_SAMPLE_HOLD,
    MODE_TRACK_HOLD,
};

class SampleHold {
  public:
    float Process(bool trigger, float input, SHMode mode = MODE_SAMPLE_HOLD) {
        if (mode == MODE_SAMPLE_HOLD) {
            if (trigger) val_ = input;
        } else {
            if (!trigger) val_ = input;
        }
        return val_;
    }
  private:
    float val_ = 0.0f;
};

} // namespace daisysp
`],

// ─── Utility/smooth_random.h — Smoothstep random ────────────────────
['Utility/smooth_random.h', `#pragma once
#include <cstdlib>
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class SmoothRandomGenerator {
  public:
    void Init(float sample_rate) {
        sr_    = sample_rate;
        freq_  = 1.0f;
        phase_ = 0.0f;
        from_  = 0.0f;
        to_    = RandFloat();
    }

    float Process() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.0f) {
            phase_ -= 1.0f;
            from_ = to_;
            to_   = RandFloat();
        }
        // Smoothstep interpolation
        float t = phase_ * phase_ * (3.0f - 2.0f * phase_);
        return from_ + (to_ - from_) * t;
    }

    void SetFreq(float freq) { freq_ = freq; }

  private:
    float RandFloat() { return -1.0f + 2.0f * ((float)rand() / (float)RAND_MAX); }
    float sr_, freq_, phase_, from_, to_;
};

} // namespace daisysp
`],

// ─── Noise/whitenoise.h — White noise generator ─────────────────────
['Noise/whitenoise.h', `#pragma once
#include <cstdint>

namespace daisysp {

class WhiteNoise {
  public:
    void Init() { amp_ = 1.0f; seed_ = 1; }

    float Process() {
        seed_ = seed_ * 1103515245 + 12345;
        return amp_ * ((float)(seed_ >> 16) / 32768.0f - 1.0f);
    }

    void SetAmp(float a)     { amp_ = a; }
    void SetSeed(int32_t s)  { seed_ = s == 0 ? 1 : s; }

  private:
    float   amp_;
    int32_t seed_;
};

} // namespace daisysp
`],

// ─── Noise/dust.h — Sparse random impulses ──────────────────────────
['Noise/dust.h', `#pragma once
#include <cstdlib>

namespace daisysp {

class Dust {
  public:
    void Init()                   { density_ = 0.5f; }
    void SetDensity(float d)      { density_ = d; }

    float Process() {
        float r = (float)rand() / (float)RAND_MAX;
        if (r < density_) {
            return r / density_;
        }
        return 0.0f;
    }

  private:
    float density_;
};

} // namespace daisysp
`],

// ─── Noise/fractal_noise.h — Stacked octaves ───────────────────────
['Noise/fractal_noise.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

template <typename T, int order = 5>
class FractalRandomGenerator {
  public:
    void Init(float sample_rate) {
        sr_    = sample_rate;
        freq_  = 1.0f;
        color_ = 0.5f;
        for (int i = 0; i < order; i++) {
            sources_[i].Init(sample_rate);
            sources_[i].SetFreq(freq_ * (float)(1 << i));
        }
    }

    float Process() {
        float out = 0.0f;
        float amp = 1.0f;
        float total = 0.0f;
        for (int i = 0; i < order; i++) {
            out += sources_[i].Process() * amp;
            total += amp;
            amp *= color_;
        }
        return out / total;
    }

    void SetFreq(float freq) {
        freq_ = freq;
        for (int i = 0; i < order; i++) {
            sources_[i].SetFreq(freq * (float)(1 << i));
        }
    }

    void SetColor(float color) { color_ = fclamp(color, 0.0f, 1.0f); }

  private:
    T     sources_[order];
    float sr_, freq_, color_;
};

} // namespace daisysp
`],

// ─── Dynamics/crossfade.h — Signal crossfader ───────────────────────
['Dynamics/crossfade.h', `#pragma once
#include <cmath>
#include <cstdint>

namespace daisysp {

enum CrossFadeCurve {
    CROSSFADE_LIN,
    CROSSFADE_CPOW,
    CROSSFADE_LOG,
    CROSSFADE_EXP,
};

class CrossFade {
  public:
    void Init(int curve = CROSSFADE_LIN) { curve_ = (uint8_t)curve; pos_ = 0.5f; }
    void Init()                          { Init(CROSSFADE_LIN); }

    float Process(float& in1, float& in2) {
        float a, b;
        switch (curve_) {
            case CROSSFADE_CPOW:
                a = sinf(pos_ * 1.5707963f);
                b = sinf((1.0f - pos_) * 1.5707963f);
                break;
            case CROSSFADE_LOG:
                a = 1.0f - (1.0f - pos_) * (1.0f - pos_);
                b = 1.0f - pos_ * pos_;
                break;
            case CROSSFADE_EXP:
                a = pos_ * pos_;
                b = (1.0f - pos_) * (1.0f - pos_);
                break;
            default: // LIN
                a = pos_;
                b = 1.0f - pos_;
                break;
        }
        return in1 * b + in2 * a;
    }

    void SetPos(float pos)        { pos_ = pos; }
    void SetCurve(uint8_t curve)  { curve_ = curve; }

  private:
    float   pos_;
    uint8_t curve_;
};

} // namespace daisysp
`],

// ─── Filters/ladder.h — Moog ladder filter ──────────────────────────
['Filters/ladder.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class LadderFilter {
  public:
    enum FilterMode { LP24, LP12, BP24, BP12, HP24, HP12 };

    void Init(float sample_rate) {
        sr_   = sample_rate;
        freq_ = 1000.0f;
        res_  = 0.0f;
        drv_  = 1.0f;
        pbg_  = 0.5f;
        mode_ = LP24;
        for (int i = 0; i < 4; i++) { stage_[i] = 0.0f; delay_[i] = 0.0f; }
    }

    float Process(float in) {
        float cutoff = 2.0f * sinf(PI_F * fminf(freq_ / (sr_ * 2.0f), 0.25f));
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
            default:   return stage_[3];
        }
    }

    void ProcessBlock(float* buf, size_t size) {
        for (size_t i = 0; i < size; i++) buf[i] = Process(buf[i]);
    }

    void SetFreq(float f)            { freq_ = fminf(f, sr_ * 0.45f); }
    void SetRes(float r)             { res_ = r; }
    void SetPassbandGain(float pbg)  { pbg_ = pbg; }
    void SetInputDrive(float drv)    { drv_ = fmaxf(drv, 0.01f); }
    void SetFilterMode(FilterMode m) { mode_ = m; }

  private:
    float      sr_, freq_, res_, drv_, pbg_;
    float      stage_[4], delay_[4];
    FilterMode mode_;
};

} // namespace daisysp
`],

// ─── Filters/soap.h — Second-order allpass ───────────────────────────
['Filters/soap.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class Soap {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 1000.0f; bw_ = 100.0f;
        d1_ = 0.0f; d2_ = 0.0f;
        bp_ = 0.0f; br_ = 0.0f;
    }

    void Process(float in) {
        float f = 2.0f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = freq_ / fmaxf(bw_, 1.0f);
        float qinv = 1.0f / fmaxf(q, 0.5f);
        float hp = in - qinv * d1_ - d2_;
        float band = f * hp + d1_;
        float lp = f * band + d2_;
        d1_ = band; d2_ = lp;
        bp_ = band; br_ = in - band;
    }

    void SetCenterFreq(float f)      { freq_ = f; }
    void SetFilterBandwidth(float b)  { bw_ = b; }
    float Bandpass() const            { return bp_; }
    float Bandreject() const          { return br_; }

  private:
    float sr_, freq_, bw_, d1_, d2_, bp_, br_;
};

} // namespace daisysp
`],

// ─── Synthesis/fm2.h — 2-operator FM ─────────────────────────────────
['Synthesis/fm2.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class Fm2 {
  public:
    void Init(float samplerate) {
        sr_ = samplerate;
        freq_ = 440.0f; ratio_ = 1.0f; idx_ = 1.0f;
        car_phase_ = 0.0f; mod_phase_ = 0.0f;
    }

    float Process() {
        float mod_freq = freq_ * ratio_;
        mod_phase_ += mod_freq / sr_;
        if (mod_phase_ >= 1.0f) mod_phase_ -= 1.0f;
        float mod = sinf(mod_phase_ * TWOPI_F) * idx_ * TWOPI_F;
        car_phase_ += freq_ / sr_;
        if (car_phase_ >= 1.0f) car_phase_ -= 1.0f;
        return sinf(car_phase_ * TWOPI_F + mod);
    }

    void  SetFrequency(float f) { freq_ = f; }
    void  SetRatio(float r)     { ratio_ = r; }
    void  SetIndex(float i)     { idx_ = i; }
    float GetIndex() const      { return idx_; }
    void  Reset()               { car_phase_ = 0.0f; mod_phase_ = 0.0f; }

  private:
    float sr_, freq_, ratio_, idx_;
    float car_phase_, mod_phase_;
};

} // namespace daisysp
`],

// ─── Noise/clockednoise.h — Sample-and-hold noise ───────────────────
['Noise/clockednoise.h', `#pragma once
#include <cstdint>
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class ClockedNoise {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 1.0f; phase_ = 0.0f; val_ = 0.0f;
        seed_ = 12345;
    }

    float Process() {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.0f) {
            phase_ -= 1.0f;
            seed_ = seed_ * 1103515245 + 12345;
            val_ = (float)(seed_ >> 16) / 32768.0f - 1.0f;
        }
        return val_;
    }

    void SetFreq(float freq) { freq_ = freq; }
    void Sync()              { phase_ = 1.0f; }

  private:
    float   sr_, freq_, phase_, val_;
    int32_t seed_;
};

} // namespace daisysp
`],

// ─── Effects/overdrive.h — Distortion ────────────────────────────────
['Effects/overdrive.h', `#pragma once
#include <cmath>

namespace daisysp {

class Overdrive {
  public:
    void Init()               { drive_ = 0.5f; }
    void SetDrive(float d)    { drive_ = d; }

    float Process(float in) {
        float x = in * (1.0f + drive_ * 10.0f);
        return tanhf(x);
    }

  private:
    float drive_;
};

} // namespace daisysp
`],

// ─── Effects/decimator.h — Bitcrusher/downsampler ────────────────────
['Effects/decimator.h', `#pragma once
#include <cmath>
#include <cstdint>

namespace daisysp {

class Decimator {
  public:
    void Init() { sr_factor_ = 1.0f; bits_ = 16.0f; hold_ = 0.0f; count_ = 0; smooth_ = false; }

    float Process(float input) {
        count_++;
        if (count_ >= (int)sr_factor_) { count_ = 0; hold_ = input; }
        float q = powf(2.0f, bits_);
        return roundf(hold_ * q) / q;
    }

    void SetDownsampleFactor(float f)     { sr_factor_ = fmaxf(f, 1.0f); }
    void SetBitcrushFactor(float f)       { bits_ = fmaxf(1.0f, 16.0f * (1.0f - f)); }
    void SetBitsToCrush(const uint8_t& b) { bits_ = 16.0f - (float)b; }
    void SetSmoothCrushing(bool s)        { smooth_ = s; }

  private:
    float sr_factor_, bits_, hold_;
    int   count_;
    bool  smooth_;
};

} // namespace daisysp
`],

// ─── Effects/sampleratereducer.h — Sample rate reduction ─────────────
['Effects/sampleratereducer.h', `#pragma once
#include "Utility/dsp.h"

namespace daisysp {

class SampleRateReducer {
  public:
    void Init()            { freq_ = 1.0f; hold_ = 0.0f; phase_ = 0.0f; }
    void SetFreq(float f)  { freq_ = fmaxf(f, 0.001f); }

    float Process(float in) {
        phase_ += freq_;
        if (phase_ >= 1.0f) { phase_ -= 1.0f; hold_ = in; }
        return hold_;
    }

  private:
    float freq_, hold_, phase_;
};

} // namespace daisysp
`],

// ─── Effects/wavefolder.h — Wavefolding ──────────────────────────────
['Effects/wavefolder.h', `#pragma once

namespace daisysp {

class Wavefolder {
  public:
    void Init()                { gain_ = 1.0f; offset_ = 0.0f; }
    void SetGain(float g)      { gain_ = g; }
    void SetOffset(float o)    { offset_ = o; }

    float Process(float in) {
        float x = (in + offset_) * gain_;
        while (x > 1.0f)  x = 2.0f - x;
        while (x < -1.0f) x = -2.0f - x;
        return x;
    }

  private:
    float gain_, offset_;
};

} // namespace daisysp
`],

// ─── Effects/tremolo.h — Amplitude modulation ────────────────────────
['Effects/tremolo.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class Tremolo {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        phase_ = 0.0f; freq_ = 5.0f; depth_ = 1.0f;
        waveform_ = 0;
    }

    float Process(float in) {
        phase_ += freq_ / sr_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        float lfo = (waveform_ == 0)
            ? (sinf(phase_ * TWOPI_F) * 0.5f + 0.5f)
            : ((phase_ < 0.5f) ? phase_ * 2.0f : 2.0f - phase_ * 2.0f);
        return in * (1.0f - depth_ * lfo);
    }

    void SetFreq(float f)      { freq_ = f; }
    void SetWaveform(int wf)   { waveform_ = wf; }
    void SetDepth(float d)     { depth_ = d; }

  private:
    float sr_, phase_, freq_, depth_;
    int   waveform_;
};

} // namespace daisysp
`],

// ─── Effects/pitchshifter.h — Time-domain pitch shifter ─────────────
['Effects/pitchshifter.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

#ifndef SHIFT_BUFFER_SIZE
#define SHIFT_BUFFER_SIZE 16384
#endif

namespace daisysp {

class PitchShifter {
  public:
    void Init(float sr) {
        sr_ = sr;
        transpose_ = 0.0f; fun_ = 0.0f;
        del_size_ = SHIFT_BUFFER_SIZE;
        write_pos_ = 0;
        read_phase1_ = 0.0f;
        read_phase2_ = (float)del_size_ * 0.5f;
        for (uint32_t i = 0; i < SHIFT_BUFFER_SIZE; i++) buf_[i] = 0.0f;
    }

    float Process(float& in) {
        buf_[write_pos_] = in;
        write_pos_ = (write_pos_ + 1) % del_size_;
        float ratio = powf(2.0f, transpose_ / 12.0f);
        float rate = 1.0f - ratio;
        read_phase1_ += rate;
        if (read_phase1_ >= (float)del_size_) read_phase1_ -= (float)del_size_;
        if (read_phase1_ < 0.0f) read_phase1_ += (float)del_size_;
        read_phase2_ = read_phase1_ + (float)del_size_ * 0.5f;
        if (read_phase2_ >= (float)del_size_) read_phase2_ -= (float)del_size_;
        uint32_t i1 = (uint32_t)read_phase1_ % del_size_;
        uint32_t i2 = (uint32_t)read_phase2_ % del_size_;
        float w1 = sinf(read_phase1_ / (float)del_size_ * PI_F);
        float w2 = sinf(read_phase2_ / (float)del_size_ * PI_F);
        return buf_[i1] * w1 * w1 + buf_[i2] * w2 * w2;
    }

    void SetTransposition(const float& t) { transpose_ = t; }
    void SetDelSize(uint32_t s)           { del_size_ = (s > SHIFT_BUFFER_SIZE) ? SHIFT_BUFFER_SIZE : s; }
    void SetFun(float f)                  { fun_ = f; }

  private:
    float    sr_, transpose_, fun_;
    float    buf_[SHIFT_BUFFER_SIZE];
    uint32_t write_pos_, del_size_;
    float    read_phase1_, read_phase2_;
};

} // namespace daisysp
`],

// ─── Drums/analogbassdrum.h — 808 bass drum ─────────────────────────
['Drums/analogbassdrum.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class AnalogBassDrum {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 60.0f; tone_ = 0.5f; decay_ = 0.5f;
        accent_ = 0.5f; attack_fm_ = 0.0f; self_fm_ = 0.0f;
        sustain_ = false; phase_ = 0.0f; env_ = 0.0f;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        float dec = 1.0f - (1.0f - decay_) * 0.01f;
        env_ *= dec;
        float f = freq_ + env_ * freq_ * tone_ * 4.0f;
        phase_ += f / sr_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        return sinf(phase_ * TWOPI_F) * env_ * accent_;
    }

    void  Trig()                      { env_ = 1.0f; }
    void  SetSustain(bool s)          { sustain_ = s; }
    void  SetAccent(float a)          { accent_ = a; }
    void  SetFreq(float f)            { freq_ = f; }
    void  SetTone(float t)            { tone_ = t; }
    void  SetDecay(float d)           { decay_ = d; }
    void  SetAttackFmAmount(float a)  { attack_fm_ = a; }
    void  SetSelfFmAmount(float a)    { self_fm_ = a; }

  private:
    float sr_, freq_, tone_, decay_, accent_, attack_fm_, self_fm_;
    bool  sustain_;
    float phase_, env_;
};

} // namespace daisysp
`],

// ─── Drums/analogsnaredrum.h — 808 snare drum ───────────────────────
['Drums/analogsnaredrum.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

namespace daisysp {

class AnalogSnareDrum {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 200.0f; tone_ = 0.5f; decay_ = 0.5f;
        accent_ = 0.5f; snappy_ = 0.5f;
        sustain_ = false; phase_ = 0.0f; env_ = 0.0f;
        seed_ = 12345;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        float dec = 1.0f - (1.0f - decay_) * 0.005f;
        env_ *= dec;
        phase_ += freq_ / sr_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        float body = sinf(phase_ * TWOPI_F) * (1.0f - snappy_);
        float snap = noise * snappy_;
        return (body + snap) * env_ * accent_;
    }

    void  Trig()                { env_ = 1.0f; }
    void  SetSustain(bool s)    { sustain_ = s; }
    void  SetAccent(float a)    { accent_ = a; }
    void  SetFreq(float f)      { freq_ = f; }
    void  SetTone(float t)      { tone_ = t; }
    void  SetDecay(float d)     { decay_ = d; }
    void  SetSnappy(float s)    { snappy_ = s; }

  private:
    float    sr_, freq_, tone_, decay_, accent_, snappy_;
    bool     sustain_;
    float    phase_, env_;
    uint32_t seed_;
};

} // namespace daisysp
`],

// ─── Drums/synthbassdrum.h — Synthetic bass drum ─────────────────────
['Drums/synthbassdrum.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class SyntheticBassDrum {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 60.0f; tone_ = 0.5f; decay_ = 0.5f;
        accent_ = 0.5f; dirt_ = 0.0f; fm_amt_ = 0.0f; fm_dec_ = 0.5f;
        sustain_ = false; phase_ = 0.0f; env_ = 0.0f; fm_env_ = 0.0f;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_    *= 1.0f - (1.0f - decay_) * 0.01f;
        fm_env_ *= 1.0f - (1.0f - fm_dec_) * 0.02f;
        float f = freq_ * (1.0f + fm_env_ * fm_amt_ * 8.0f);
        phase_ += f / sr_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        return sinf(phase_ * TWOPI_F) * env_ * accent_;
    }

    void  Trig()                         { env_ = 1.0f; fm_env_ = 1.0f; }
    void  SetSustain(bool s)             { sustain_ = s; }
    void  SetAccent(float a)             { accent_ = a; }
    void  SetFreq(float f)               { freq_ = f; }
    void  SetTone(float t)               { tone_ = t; }
    void  SetDecay(float d)              { decay_ = d; }
    void  SetDirtiness(float d)          { dirt_ = d; }
    void  SetFmEnvelopeAmount(float a)   { fm_amt_ = a; }
    void  SetFmEnvelopeDecay(float d)    { fm_dec_ = d; }

  private:
    float sr_, freq_, tone_, decay_, accent_, dirt_, fm_amt_, fm_dec_;
    bool  sustain_;
    float phase_, env_, fm_env_;
};

} // namespace daisysp
`],

// ─── Drums/synthsnaredrum.h — Synthetic snare drum ───────────────────
['Drums/synthsnaredrum.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

namespace daisysp {

class SyntheticSnareDrum {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 200.0f; fm_amt_ = 0.5f; decay_ = 0.5f;
        accent_ = 0.5f; snappy_ = 0.5f;
        sustain_ = false; phase_ = 0.0f; env_ = 0.0f;
        seed_ = 54321;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 1.0f - (1.0f - decay_) * 0.005f;
        phase_ += freq_ / sr_;
        if (phase_ >= 1.0f) phase_ -= 1.0f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        return (sinf(phase_ * TWOPI_F) * (1.0f - snappy_) + noise * snappy_) * env_ * accent_;
    }

    void  Trig()                  { env_ = 1.0f; }
    void  SetSustain(bool s)      { sustain_ = s; }
    void  SetAccent(float a)      { accent_ = a; }
    void  SetFreq(float f)        { freq_ = f; }
    void  SetFmAmount(float f)    { fm_amt_ = f; }
    void  SetDecay(float d)       { decay_ = d; }
    void  SetSnappy(float s)      { snappy_ = s; }

  private:
    float    sr_, freq_, fm_amt_, decay_, accent_, snappy_;
    bool     sustain_;
    float    phase_, env_;
    uint32_t seed_;
};

} // namespace daisysp
`],

// ─── Drums/hihat.h — Hi-hat ─────────────────────────────────────────
['Drums/hihat.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

namespace daisysp {

struct SquareNoise {};
struct RingModNoise {};
struct LinearVCA {};
struct SwingVCA {};

template <typename NoiseSource = SquareNoise, typename VCA = LinearVCA, bool resonance = true>
class HiHat {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 3000.0f; tone_ = 0.5f; decay_ = 0.5f;
        accent_ = 0.5f; noisiness_ = 0.5f;
        sustain_ = false; env_ = 0.0f;
        seed_ = 98765;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 1.0f - (1.0f - decay_) * 0.003f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        return noise * env_ * accent_;
    }

    void  Trig()                   { env_ = 1.0f; }
    void  SetSustain(bool s)       { sustain_ = s; }
    void  SetAccent(float a)       { accent_ = a; }
    void  SetFreq(float f)         { freq_ = f; }
    void  SetTone(float t)         { tone_ = t; }
    void  SetDecay(float d)        { decay_ = d; }
    void  SetNoisiness(float n)    { noisiness_ = n; }

  private:
    float    sr_, freq_, tone_, decay_, accent_, noisiness_;
    bool     sustain_;
    float    env_;
    uint32_t seed_;
};

} // namespace daisysp
`],

// ─── PhysicalModeling/KarplusString.h — Karplus-Strong string ────────
['PhysicalModeling/KarplusString.h', `#pragma once
#include <cmath>
#include <cstddef>
#include "Utility/dsp.h"
#include "Utility/delayline.h"

namespace daisysp {

class String {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 440.0f;
        brightness_ = 0.5f;
        damping_ = 0.5f;
        nonlin_ = 0.0f;
        delay_.Init();
        SetFreq(freq_);
        prev_ = 0.0f;
    }

    void Reset() { delay_.Reset(); prev_ = 0.0f; }

    float Process(const float in) {
        float read = delay_.Read(delay_len_);
        float filt = prev_ + (1.0f - damping_ * 0.5f) * (read - prev_);
        filt *= brightness_ * 0.5f + 0.5f;
        prev_ = filt;
        delay_.Write(in + filt * 0.998f);
        return read;
    }

    void SetFreq(float f) {
        freq_ = fmaxf(f, 20.0f);
        delay_len_ = fminf(sr_ / freq_, 1023.0f);
    }
    void SetBrightness(float b)   { brightness_ = b; }
    void SetDamping(float d)      { damping_ = d; }
    void SetNonLinearity(float n) { nonlin_ = n; }

  private:
    float sr_, freq_, brightness_, damping_, nonlin_;
    float delay_len_ = 100.0f;
    float prev_ = 0.0f;
    DelayLine<float, 1024> delay_;
};

} // namespace daisysp
`],

// ─── PhysicalModeling/stringvoice.h — String voice with exciter ──────
['PhysicalModeling/stringvoice.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"
#include "PhysicalModeling/KarplusString.h"

namespace daisysp {

class StringVoice {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        string_.Init(sample_rate);
        env_ = 0.0f; aux_ = 0.0f;
        accent_ = 0.5f; sustain_ = false;
        seed_ = 11111;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 0.997f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        float excitation = noise * env_ * accent_;
        if (sustain_) {
            seed_ = seed_ * 1664525u + 1013904223u;
            excitation += ((float)(int32_t)seed_ / 2147483648.0f) * 0.002f;
        }
        aux_ = excitation;
        return string_.Process(excitation);
    }

    void  Trig()                    { env_ = 1.0f; }
    void  Reset()                   { string_.Reset(); }
    void  SetSustain(bool s)        { sustain_ = s; }
    void  SetFreq(float f)          { string_.SetFreq(f); }
    void  SetAccent(float a)        { accent_ = a; }
    void  SetStructure(float s)     { string_.SetNonLinearity(s < 0.26f ? s * 3.8f - 1.0f : (s - 0.26f) / 0.74f); }
    void  SetBrightness(float b)    { string_.SetBrightness(b); }
    void  SetDamping(float d)       { string_.SetDamping(d); }
    float GetAux() const            { return aux_; }

  private:
    float    sr_, env_, aux_, accent_;
    bool     sustain_;
    uint32_t seed_;
    String   string_;
};

} // namespace daisysp
`],

// ─── PhysicalModeling/modalvoice.h — Modal synthesis voice ───────────
['PhysicalModeling/modalvoice.h', `#pragma once
#include <cmath>
#include <cstdint>
#include "Utility/dsp.h"

namespace daisysp {

class ModalVoice {
  public:
    void Init(float sample_rate) {
        sr_ = sample_rate;
        freq_ = 440.0f; accent_ = 0.5f;
        structure_ = 0.5f; brightness_ = 0.5f; damping_ = 0.5f;
        sustain_ = false; env_ = 0.0f; aux_ = 0.0f;
        d1_ = 0.0f; d2_ = 0.0f;
        seed_ = 22222;
    }

    float Process(bool trigger = false) {
        if (trigger) Trig();
        env_ *= 0.997f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        float excitation = noise * env_ * accent_;
        aux_ = excitation;
        float f = 2.0f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = 1.0f / (1.0f + (1.0f - damping_) * 0.1f);
        float hp = excitation - q * d1_ - d2_;
        float bp = f * hp + d1_;
        float lp = f * bp + d2_;
        d1_ = bp; d2_ = lp;
        return bp * brightness_;
    }

    void  Trig()                    { env_ = 1.0f; }
    void  SetSustain(bool s)        { sustain_ = s; }
    void  SetFreq(float f)          { freq_ = f; }
    void  SetAccent(float a)        { accent_ = a; }
    void  SetStructure(float s)     { structure_ = s; }
    void  SetBrightness(float b)    { brightness_ = b; }
    void  SetDamping(float d)       { damping_ = d; }
    float GetAux() const            { return aux_; }

  private:
    float    sr_, freq_, accent_, structure_, brightness_, damping_;
    bool     sustain_;
    float    env_, aux_, d1_, d2_;
    uint32_t seed_;
};

} // namespace daisysp
`],

// ─── PhysicalModeling/resonator.h — Resonant body ────────────────────
['PhysicalModeling/resonator.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class Resonator {
  public:
    void Init(float position, int resolution, float sample_rate) {
        sr_ = sample_rate;
        freq_ = 440.0f; structure_ = 0.5f;
        brightness_ = 0.5f; damping_ = 0.5f;
        d1_ = 0.0f; d2_ = 0.0f;
        (void)position; (void)resolution;
    }

    float Process(const float in) {
        float f = 2.0f * sinf(PI_F * fminf(freq_ / sr_, 0.45f));
        float q = 1.0f / (1.0f + (1.0f - damping_) * 0.1f);
        float hp = in - q * d1_ - d2_;
        float bp = f * hp + d1_;
        float lp = f * bp + d2_;
        d1_ = bp; d2_ = lp;
        return bp;
    }

    void SetFreq(float f)         { freq_ = f; }
    void SetStructure(float s)    { structure_ = s; }
    void SetBrightness(float b)   { brightness_ = b; }
    void SetDamping(float d)      { damping_ = d; }

  private:
    float sr_, freq_, structure_, brightness_, damping_;
    float d1_, d2_;
};

} // namespace daisysp
`],

// ─── PhysicalModeling/drip.h — Water drip model ─────────────────────
['PhysicalModeling/drip.h', `#pragma once
#include <cmath>
#include <cstdint>

namespace daisysp {

class Drip {
  public:
    void Init(float sample_rate, float dettack) {
        sr_ = sample_rate; env_ = 0.0f; seed_ = 33333;
        (void)dettack;
    }

    float Process(bool trig) {
        if (trig) env_ = 1.0f;
        env_ *= 0.999f;
        seed_ = seed_ * 1664525u + 1013904223u;
        float noise = (float)(int32_t)seed_ / 2147483648.0f;
        return noise * env_ * env_ * 0.3f;
    }

  private:
    float    sr_, env_;
    uint32_t seed_;
};

} // namespace daisysp
`],

// ─── Dynamics/limiter.h — Peak limiter ───────────────────────────────
['Dynamics/limiter.h', `#pragma once
#include <cstddef>

namespace daisysp {

class Limiter {
  public:
    void Init() {}

    void ProcessBlock(float* in, size_t size, float pre_gain) {
        for (size_t i = 0; i < size; i++) {
            in[i] *= pre_gain;
            if (in[i] > 1.0f)  in[i] = 1.0f;
            if (in[i] < -1.0f) in[i] = -1.0f;
        }
    }
};

} // namespace daisysp
`],

// ─── Sampling/granularplayer.h — Granular sample player ──────────────
['Sampling/granularplayer.h', `#pragma once
#include <cmath>
#include "Utility/dsp.h"

namespace daisysp {

class GranularPlayer {
  public:
    void Init(float* sample, int size, float sample_rate) {
        sample_ = sample; size_ = size; sr_ = sample_rate;
        pos_ = 0.0f;
        for (int i = 0; i < 256; i++) {
            cos_env_[i] = 0.5f * (1.0f - cosf(TWOPI_F * (float)i / 256.0f));
        }
    }

    float Process(float speed, float transposition, float grain_size) {
        if (!sample_ || size_ <= 0) return 0.0f;
        float pitch_ratio = powf(2.0f, transposition / 1200.0f);
        pos_ += speed;
        if (pos_ >= (float)size_) pos_ -= (float)size_;
        if (pos_ < 0.0f) pos_ += (float)size_;
        int idx = (int)pos_ % size_;
        return sample_[idx] * pitch_ratio;
    }

  private:
    float* sample_ = nullptr;
    int    size_ = 0;
    float  sr_ = 48000.0f;
    float  pos_ = 0.0f;
    float  cos_env_[256];
};

} // namespace daisysp
`],

]);
