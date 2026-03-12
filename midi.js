// daisy-gpt browser edition — Web MIDI controller
// Monophonic last-note priority, 1V/Oct CV output

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Computer keyboard → MIDI note mapping (C4 octave)
const KEY_NOTE_MAP = {
  'z': 60, 's': 61, 'x': 62, 'd': 63, 'c': 64,  // C4-E4
  'v': 65, 'g': 66, 'b': 67, 'h': 68, 'n': 69,  // F4-A4
  'j': 70, 'm': 71, ',': 72,                       // A#4-C5
};

export class MIDIController {
  constructor() {
    this.midiAccess = null;
    this.activeInput = null;
    this.noteStack = [];       // last-note priority stack
    this.currentNote = -1;
    this.pitchCV = 0.0;        // 1V/Oct: (note-60)/12
    this.velocity = 0.0;       // 0.0-1.0
    this.pitchBend = 0.0;      // -1.0 to 1.0
    this.gate = false;
    this.connected = false;
    this.ccKnobMap = [1, 2, 3, 4]; // CC numbers mapped to knobs 0-3
    this.keyboardOctave = 0;       // octave offset for computer keyboard

    // Callbacks (set by app.js)
    this.onStateChange = null;  // (state) => {}
    this.onKnobChange = null;   // (index, value) => {}
    this.onDevicesChange = null; // (devices) => {}

    this._keydownHandler = this._onKeydown.bind(this);
    this._keyupHandler = this._onKeyup.bind(this);
    this._keysHeld = new Set();
  }

  async init() {
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI API not supported');
      return false;
    }
    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
      this.midiAccess.onstatechange = () => this._enumerateDevices();
      this._enumerateDevices();
      this._enableKeyboard();
      return true;
    } catch (err) {
      console.warn('MIDI access denied:', err.message);
      return false;
    }
  }

  getDevices() {
    if (!this.midiAccess) return [];
    const devices = [];
    for (const input of this.midiAccess.inputs.values()) {
      devices.push({ id: input.id, name: input.name || `MIDI Input ${input.id}` });
    }
    return devices;
  }

  selectDevice(deviceId) {
    // Disconnect previous
    if (this.activeInput) {
      this.activeInput.onmidimessage = null;
      this.activeInput = null;
    }

    if (!deviceId || !this.midiAccess) {
      this.connected = false;
      this._notifyState();
      return;
    }

    const input = this.midiAccess.inputs.get(deviceId);
    if (!input) return;

    this.activeInput = input;
    this.activeInput.onmidimessage = (e) => this._onMIDIMessage(e);
    this.connected = true;
    this._notifyState();
  }

  setCC(knobIndex, ccNumber) {
    if (knobIndex >= 0 && knobIndex < 4) {
      this.ccKnobMap[knobIndex] = ccNumber;
      localStorage.setItem('daisy-gpt-midi-cc-map', JSON.stringify(this.ccKnobMap));
    }
  }

  loadCCMap() {
    try {
      const saved = localStorage.getItem('daisy-gpt-midi-cc-map');
      if (saved) this.ccKnobMap = JSON.parse(saved);
    } catch { /* ignore */ }
  }

  destroy() {
    if (this.activeInput) {
      this.activeInput.onmidimessage = null;
    }
    this._disableKeyboard();
  }

  // ─── Internal ─────────────────────────────────────────────────

  _enumerateDevices() {
    if (this.onDevicesChange) {
      this.onDevicesChange(this.getDevices());
    }
  }

  _onMIDIMessage(event) {
    const [status, data1, data2] = event.data;
    const cmd = status & 0xf0;

    switch (cmd) {
      case 0x90: // Note On
        if (data2 > 0) {
          this._noteOn(data1, data2);
        } else {
          this._noteOff(data1); // velocity 0 = note off
        }
        break;
      case 0x80: // Note Off
        this._noteOff(data1);
        break;
      case 0xb0: // CC
        this._onCC(data1, data2);
        break;
      case 0xe0: // Pitch Bend
        this._onPitchBend(data1, data2);
        break;
    }
  }

  _noteOn(note, velocity) {
    // Remove if already in stack, push to top
    this.noteStack = this.noteStack.filter(n => n !== note);
    this.noteStack.push(note);

    this.currentNote = note;
    this.pitchCV = (note - 60) / 12.0;
    this.velocity = velocity / 127.0;
    this.gate = true;
    this._notifyState();
  }

  _noteOff(note) {
    this.noteStack = this.noteStack.filter(n => n !== note);

    if (this.noteStack.length > 0) {
      // Last-note priority: fall back to previous note
      this.currentNote = this.noteStack[this.noteStack.length - 1];
      this.pitchCV = (this.currentNote - 60) / 12.0;
      // Keep gate on, keep last velocity
    } else {
      this.gate = false;
    }
    this._notifyState();
  }

  _onCC(cc, value) {
    // All-notes-off
    if (cc === 123) {
      this.noteStack = [];
      this.currentNote = -1;
      this.gate = false;
      this._notifyState();
      return;
    }

    // Map CC to knob
    const knobIndex = this.ccKnobMap.indexOf(cc);
    if (knobIndex !== -1 && this.onKnobChange) {
      this.onKnobChange(knobIndex, value / 127.0);
    }
  }

  _onPitchBend(lsb, msb) {
    const raw = (msb << 7) | lsb; // 0-16383, center 8192
    this.pitchBend = (raw - 8192) / 8192.0;
    this._notifyState();
  }

  _notifyState() {
    if (this.onStateChange) {
      this.onStateChange({
        note: this.currentNote,
        noteName: this.currentNote >= 0 ? this._noteName(this.currentNote) : '--',
        pitchCV: this.pitchCV,
        velocity: this.velocity,
        pitchBend: this.pitchBend,
        gate: this.gate,
        connected: this.connected,
      });
    }
  }

  _noteName(note) {
    const name = NOTE_NAMES[note % 12];
    const octave = Math.floor(note / 12) - 1;
    return `${name}${octave}`;
  }

  // ─── Computer Keyboard ────────────────────────────────────────

  _enableKeyboard() {
    document.addEventListener('keydown', this._keydownHandler);
    document.addEventListener('keyup', this._keyupHandler);
  }

  _disableKeyboard() {
    document.removeEventListener('keydown', this._keydownHandler);
    document.removeEventListener('keyup', this._keyupHandler);
  }

  _onKeydown(e) {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    const key = e.key.toLowerCase();
    if (KEY_NOTE_MAP[key] !== undefined && !this._keysHeld.has(key)) {
      e.preventDefault();
      this._keysHeld.add(key);
      const note = KEY_NOTE_MAP[key] + (this.keyboardOctave * 12);
      this._noteOn(note, 100);
    }
  }

  _onKeyup(e) {
    const key = e.key.toLowerCase();
    if (KEY_NOTE_MAP[key] !== undefined && this._keysHeld.has(key)) {
      this._keysHeld.delete(key);
      const note = KEY_NOTE_MAP[key] + (this.keyboardOctave * 12);
      this._noteOff(note);
    }
  }
}
