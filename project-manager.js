// Project manager — handles multi-file project state, persistence, and templates
import { BOARDS, DEFAULT_BOARD, getBoardTemplate } from './boards.js';

const STORAGE_KEY = 'daisy-gpt-project';
const PROJECTS_LIST_KEY = 'daisy-gpt-projects-list';
const VERSION_PREFIX = 'daisy-gpt-versions-';
const MAX_VERSIONS = 20;

/**
 * Create a new project with default template for the given board.
 */
export function createProject(name = 'untitled', boardId = DEFAULT_BOARD, { description = '', tags = [] } = {}) {
  const board = BOARDS[boardId] || BOARDS[DEFAULT_BOARD];
  const mainFile = 'main.cpp';
  return {
    name,
    board: boardId,
    activeFile: mainFile,
    openTabs: [mainFile],
    files: {
      [mainFile]: {
        content: getBoardTemplate(boardId),
        dirty: false,
      },
    },
    description,
    tags,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Add a file to a project. Returns the updated project.
 */
export function addFile(project, filePath, content = '') {
  if (project.files[filePath]) {
    throw new Error(`File "${filePath}" already exists`);
  }
  project.files[filePath] = { content, dirty: false };
  project.updatedAt = Date.now();
  return project;
}

/**
 * Delete a file from a project. Returns the updated project.
 */
export function deleteFile(project, filePath) {
  if (!project.files[filePath]) {
    throw new Error(`File "${filePath}" does not exist`);
  }
  if (Object.keys(project.files).length <= 1) {
    throw new Error('Cannot delete the last file');
  }
  delete project.files[filePath];
  project.openTabs = project.openTabs.filter(t => t !== filePath);
  if (project.activeFile === filePath) {
    project.activeFile = project.openTabs[0] || Object.keys(project.files)[0];
  }
  project.updatedAt = Date.now();
  return project;
}

/**
 * Rename a file in a project. Returns the updated project.
 */
export function renameFile(project, oldPath, newPath) {
  if (!project.files[oldPath]) {
    throw new Error(`File "${oldPath}" does not exist`);
  }
  if (project.files[newPath]) {
    throw new Error(`File "${newPath}" already exists`);
  }
  project.files[newPath] = project.files[oldPath];
  delete project.files[oldPath];
  project.openTabs = project.openTabs.map(t => t === oldPath ? newPath : t);
  if (project.activeFile === oldPath) {
    project.activeFile = newPath;
  }
  project.updatedAt = Date.now();
  return project;
}

/**
 * Update file content. Returns the updated project.
 */
export function updateFileContent(project, filePath, content) {
  if (!project.files[filePath]) {
    throw new Error(`File "${filePath}" does not exist`);
  }
  project.files[filePath].content = content;
  project.files[filePath].dirty = true;
  project.updatedAt = Date.now();
  return project;
}

/**
 * Get the content of the active file.
 */
export function getActiveFileContent(project) {
  const file = project.files[project.activeFile];
  return file ? file.content : '';
}

/**
 * Get all file paths in the project, sorted.
 */
export function getFilePaths(project) {
  return Object.keys(project.files).sort();
}

/**
 * Get all .cpp file paths (for compilation).
 */
export function getCppFiles(project) {
  return Object.entries(project.files)
    .filter(([path]) => path.endsWith('.cpp') || path.endsWith('.cc'))
    .map(([path, file]) => ({ path, content: file.content }));
}

/**
 * Get all files as a flat object (for compilation server).
 */
export function getAllFiles(project) {
  const result = {};
  for (const [path, file] of Object.entries(project.files)) {
    result[path] = file.content;
  }
  return result;
}

/**
 * Get a project summary string for AI context.
 */
export function getProjectSummary(project) {
  const board = BOARDS[project.board] || BOARDS[DEFAULT_BOARD];
  const filePaths = getFilePaths(project);
  let summary = `PROJECT: "${project.name}" | BOARD: ${board.name} (${board.className})\n`;
  summary += `FILES (${filePaths.length}):\n`;
  for (const path of filePaths) {
    const lines = project.files[path].content.split('\n').length;
    const active = path === project.activeFile ? ' [ACTIVE]' : '';
    summary += `  - ${path} (${lines} lines)${active}\n`;
  }
  return summary;
}

/**
 * Get full project context for LLM — all files with contents.
 */
export function getProjectContext(project) {
  const filePaths = getFilePaths(project);
  let context = '';
  for (const path of filePaths) {
    context += `--- ${path}\n\`\`\`cpp\n${project.files[path].content}\n\`\`\`\n\n`;
  }
  return context;
}

// ─── Persistence ────────────────────────────────────────────────

const PROJECT_PREFIX = 'daisy-gpt-proj-';

function projectKey(name) {
  return PROJECT_PREFIX + name;
}

/**
 * Save the current project to localStorage (also persists to the multi-project store).
 */
export function saveProject(project) {
  try {
    // Mark all files as clean on save
    for (const file of Object.values(project.files)) {
      file.dirty = false;
    }
    project.updatedAt = Date.now();

    // Save a version snapshot
    saveVersion(project);

    // Save as the "current" project
    localStorage.setItem(STORAGE_KEY, JSON.stringify(project));

    // Also save to the multi-project store
    localStorage.setItem(projectKey(project.name), JSON.stringify(project));

    // Update the projects list index
    updateProjectsIndex(project);
  } catch (e) {
    console.error('Failed to save project:', e);
  }
}

/**
 * Save project under a new name. Returns the renamed project.
 */
export function saveProjectAs(project, newName) {
  if (!newName || !newName.trim()) throw new Error('Project name cannot be empty');
  newName = newName.trim();

  // Remove old entry if renaming
  if (project.name !== newName) {
    deleteProjectByName(project.name);
  }

  project.name = newName;
  saveProject(project);
  return project;
}

/**
 * Load the current project from localStorage.
 */
export function loadProject() {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    console.error('Failed to load project:', e);
    return null;
  }
}

/**
 * Load a specific project by name from the multi-project store.
 */
export function loadProjectByName(name) {
  try {
    const json = localStorage.getItem(projectKey(name));
    if (!json) return null;
    return JSON.parse(json);
  } catch (e) {
    console.error('Failed to load project:', e);
    return null;
  }
}

/**
 * Delete a project by name from the multi-project store.
 */
export function deleteProjectByName(name) {
  try {
    localStorage.removeItem(projectKey(name));

    // Remove from index
    const list = loadProjectsList();
    const filtered = list.filter(p => p.name !== name);
    localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.error('Failed to delete project:', e);
  }
}

/**
 * Duplicate a project under a new name. Returns the new project.
 */
export function duplicateProject(project, newName) {
  const copy = JSON.parse(JSON.stringify(project));
  copy.name = newName;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  saveProject(copy);
  return copy;
}

/**
 * Rename a project. Returns the updated project.
 */
export function renameProject(project, newName) {
  if (!newName || !newName.trim()) throw new Error('Project name cannot be empty');
  newName = newName.trim();
  if (newName === project.name) return project;

  // Check if target name already exists
  const existing = loadProjectByName(newName);
  if (existing) throw new Error(`Project "${newName}" already exists`);

  const oldName = project.name;
  project.name = newName;
  project.updatedAt = Date.now();

  // Remove old storage key
  localStorage.removeItem(projectKey(oldName));

  // Save under new name
  saveProject(project);
  return project;
}

/**
 * Load the list of saved projects (metadata only).
 */
export function loadProjectsList() {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_LIST_KEY) || '[]');
  } catch {
    return [];
  }
}

/**
 * Update the projects index with the given project's metadata.
 */
function updateProjectsIndex(project) {
  const list = loadProjectsList();
  const existing = list.findIndex(p => p.name === project.name);
  const entry = {
    name: project.name,
    board: project.board,
    fileCount: Object.keys(project.files).length,
    updatedAt: project.updatedAt,
    description: project.description || '',
    tags: project.tags || [],
  };
  if (existing >= 0) {
    list[existing] = entry;
  } else {
    list.unshift(entry);
  }
  if (list.length > 50) list.length = 50;
  localStorage.setItem(PROJECTS_LIST_KEY, JSON.stringify(list));
}

/**
 * Check if any files have unsaved changes.
 */
export function hasUnsavedChanges(project) {
  return Object.values(project.files).some(f => f.dirty);
}

/**
 * Migrate a legacy single-file state.code into a project.
 */
export function migrateFromLegacy(code, board = DEFAULT_BOARD) {
  const project = createProject('migrated-patch', board);
  if (code && code.trim()) {
    project.files['main.cpp'].content = code;
  }
  return project;
}

// ─── Version History ────────────────────────────────────────────────

/**
 * Save a version snapshot of the project.
 * Called automatically inside saveProject().
 */
export function saveVersion(project) {
  try {
    const key = VERSION_PREFIX + project.name;
    const versions = getVersionHistory(project.name);

    // Build file contents snapshot
    const filesSnapshot = {};
    for (const [path, file] of Object.entries(project.files)) {
      filesSnapshot[path] = file.content;
    }

    const version = {
      timestamp: Date.now(),
      files: filesSnapshot,
      board: project.board,
      activeFile: project.activeFile,
    };

    versions.unshift(version);
    if (versions.length > MAX_VERSIONS) versions.length = MAX_VERSIONS;

    localStorage.setItem(key, JSON.stringify(versions));
  } catch (e) {
    console.error('Failed to save version:', e);
  }
}

/**
 * Get the version history for a project.
 * @returns {Array} Array of version snapshots, newest first.
 */
export function getVersionHistory(projectName) {
  try {
    const key = VERSION_PREFIX + projectName;
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

/**
 * Restore a project to a previous version.
 * @param {Object} project - The project to restore
 * @param {number} versionIndex - Index in the version history array
 * @returns {Object} The restored project
 */
export function restoreVersion(project, versionIndex) {
  const versions = getVersionHistory(project.name);
  if (versionIndex < 0 || versionIndex >= versions.length) {
    throw new Error('Invalid version index');
  }
  const version = versions[versionIndex];

  // Restore files from snapshot
  project.files = {};
  for (const [path, content] of Object.entries(version.files)) {
    project.files[path] = { content, dirty: false };
  }
  project.board = version.board;
  project.activeFile = version.activeFile;
  project.openTabs = [version.activeFile];
  project.updatedAt = Date.now();

  return project;
}

/**
 * Clear all version history for a project.
 */
export function clearVersionHistory(projectName) {
  localStorage.removeItem(VERSION_PREFIX + projectName);
}

// ─── Search Across Projects ─────────────────────────────────────────

/**
 * Search across all saved projects' file contents and file names.
 * @param {string} query - Search query (case-insensitive substring)
 * @returns {Array<{projectName, fileName, line, lineNumber, snippet}>}
 */
export function searchProjects(query) {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase().trim();
  const results = [];
  const list = loadProjectsList();

  for (const entry of list) {
    const project = loadProjectByName(entry.name);
    if (!project) continue;

    for (const [filePath, file] of Object.entries(project.files)) {
      // Match file name
      if (filePath.toLowerCase().includes(q)) {
        results.push({
          projectName: entry.name,
          fileName: filePath,
          line: filePath,
          lineNumber: 0,
          snippet: `File: ${filePath}`,
        });
      }

      // Match file content lines
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          results.push({
            projectName: entry.name,
            fileName: filePath,
            line: lines[i].trim(),
            lineNumber: i + 1,
            snippet: lines[i].trim().substring(0, 120),
          });
        }
      }
    }
  }

  return results;
}

// ─── Project Templates ──────────────────────────────────────────────

export const TEMPLATES = {
  'basic-oscillator': {
    name: 'Basic Oscillator',
    description: 'Sine wave oscillator with knob-controlled frequency and amplitude.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
Oscillator osc;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  hw.ProcessAllControls();
  float freq_knob = hw.adc.GetFloat(0); // Knob 1: Frequency
  float amp_knob = hw.adc.GetFloat(1);  // Knob 2: Amplitude

  float freq = 80.0f + freq_knob * 2000.0f;
  osc.SetFreq(freq);
  osc.SetAmp(amp_knob);

  for (size_t i = 0; i < size; i++) {
    float sig = osc.Process();
    out[0][i] = sig;
    out[1][i] = sig;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);
  float sr = hw.AudioSampleRate();

  AdcChannelConfig adc_cfg[2];
  adc_cfg[0].InitSingle(seed::A0);
  adc_cfg[1].InitSingle(seed::A1);
  hw.adc.Init(adc_cfg, 2);
  hw.adc.Start();

  osc.Init(sr);
  osc.SetWaveform(Oscillator::WAVE_SIN);
  osc.SetFreq(440.0f);
  osc.SetAmp(0.5f);

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },

  'fm-synth': {
    name: 'FM Synthesizer',
    description: 'Two-operator FM synthesis with ratio and depth knob controls.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
Oscillator carrier;
Oscillator modulator;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  hw.ProcessAllControls();
  float ratio_knob = hw.adc.GetFloat(0); // Knob 1: FM Ratio
  float depth_knob = hw.adc.GetFloat(1); // Knob 2: FM Depth

  float base_freq = 220.0f;
  float ratio = 1.0f + ratio_knob * 7.0f;
  float depth = depth_knob * 1000.0f;

  modulator.SetFreq(base_freq * ratio);
  modulator.SetAmp(depth);

  for (size_t i = 0; i < size; i++) {
    float mod_sig = modulator.Process();
    carrier.SetFreq(base_freq + mod_sig);
    float sig = carrier.Process();
    out[0][i] = sig * 0.5f;
    out[1][i] = sig * 0.5f;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);
  float sr = hw.AudioSampleRate();

  AdcChannelConfig adc_cfg[2];
  adc_cfg[0].InitSingle(seed::A0);
  adc_cfg[1].InitSingle(seed::A1);
  hw.adc.Init(adc_cfg, 2);
  hw.adc.Start();

  carrier.Init(sr);
  carrier.SetWaveform(Oscillator::WAVE_SIN);
  carrier.SetFreq(220.0f);
  carrier.SetAmp(0.5f);

  modulator.Init(sr);
  modulator.SetWaveform(Oscillator::WAVE_SIN);
  modulator.SetFreq(220.0f);
  modulator.SetAmp(0.0f);

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },

  'delay-effect': {
    name: 'Delay Effect',
    description: 'Stereo delay effect with feedback and mix controls.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
DelayLine<float, 48000> delayL;
DelayLine<float, 48000> delayR;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  hw.ProcessAllControls();
  float time_knob = hw.adc.GetFloat(0);   // Knob 1: Delay Time
  float fb_knob = hw.adc.GetFloat(1);     // Knob 2: Feedback

  float delay_samples = 2400.0f + time_knob * 45600.0f;
  float feedback = fb_knob * 0.9f;

  delayL.SetDelay(delay_samples);
  delayR.SetDelay(delay_samples * 1.05f);

  for (size_t i = 0; i < size; i++) {
    float dry_l = in[0][i];
    float dry_r = in[1][i];

    float del_l = delayL.Read();
    float del_r = delayR.Read();

    delayL.Write(dry_l + del_l * feedback);
    delayR.Write(dry_r + del_r * feedback);

    out[0][i] = dry_l + del_l * 0.5f;
    out[1][i] = dry_r + del_r * 0.5f;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);

  AdcChannelConfig adc_cfg[2];
  adc_cfg[0].InitSingle(seed::A0);
  adc_cfg[1].InitSingle(seed::A1);
  hw.adc.Init(adc_cfg, 2);
  hw.adc.Start();

  delayL.Init();
  delayR.Init();

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },

  'midi-controller': {
    name: 'MIDI Controller',
    description: 'MIDI note input with ADSR envelope for mono synth voice.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
Oscillator osc;
Adsr env;
MidiUsbHandler midi;

bool gate = false;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  // Handle MIDI events
  midi.Listen();
  while (midi.HasEvents()) {
    auto msg = midi.PopEvent();
    if (msg.type == NoteOn) {
      auto note = msg.AsNoteOn();
      if (note.velocity > 0) {
        float freq = mtof(note.note);
        osc.SetFreq(freq);
        gate = true;
      } else {
        gate = false;
      }
    } else if (msg.type == NoteOff) {
      gate = false;
    }
  }

  for (size_t i = 0; i < size; i++) {
    float env_sig = env.Process(gate);
    float osc_sig = osc.Process();
    float sig = osc_sig * env_sig;
    out[0][i] = sig;
    out[1][i] = sig;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);
  float sr = hw.AudioSampleRate();

  MidiUsbHandler::Config midi_cfg;
  midi_cfg.transport_config.periph = MidiUsbTransport::Config::INTERNAL;
  midi.Init(midi_cfg);

  osc.Init(sr);
  osc.SetWaveform(Oscillator::WAVE_SAW);
  osc.SetFreq(440.0f);
  osc.SetAmp(0.8f);

  env.Init(sr);
  env.SetAttackTime(0.01f);
  env.SetDecayTime(0.2f);
  env.SetSustainLevel(0.7f);
  env.SetReleaseTime(0.3f);

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },

  'noise-generator': {
    name: 'Noise Generator',
    description: 'White/pink noise source with resonant low-pass filter.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
WhiteNoise noise;
Svf filter;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  hw.ProcessAllControls();
  float cutoff_knob = hw.adc.GetFloat(0); // Knob 1: Filter Cutoff
  float res_knob = hw.adc.GetFloat(1);    // Knob 2: Resonance

  float cutoff = 100.0f + cutoff_knob * 8000.0f;
  float resonance = res_knob * 0.9f;

  filter.SetFreq(cutoff);
  filter.SetRes(resonance);

  for (size_t i = 0; i < size; i++) {
    float n = noise.Process();
    filter.Process(n);
    float sig = filter.Low();
    out[0][i] = sig * 0.5f;
    out[1][i] = sig * 0.5f;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);
  float sr = hw.AudioSampleRate();

  AdcChannelConfig adc_cfg[2];
  adc_cfg[0].InitSingle(seed::A0);
  adc_cfg[1].InitSingle(seed::A1);
  hw.adc.Init(adc_cfg, 2);
  hw.adc.Start();

  noise.Init();
  noise.SetAmp(1.0f);

  filter.Init(sr);
  filter.SetFreq(1000.0f);
  filter.SetRes(0.3f);

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },

  'lfo-vca': {
    name: 'LFO + VCA',
    description: 'Tremolo effect using an LFO to modulate a VCA on the audio input.',
    board: 'seed',
    code: `#include "daisy_seed.h"
#include "daisysp.h"

using namespace daisy;
using namespace daisysp;

DaisySeed hw;
Oscillator lfo;
Oscillator audio_osc;

void AudioCallback(AudioHandle::InputBuffer in,
                   AudioHandle::OutputBuffer out,
                   size_t size) {
  hw.ProcessAllControls();
  float rate_knob = hw.adc.GetFloat(0);  // Knob 1: LFO Rate
  float depth_knob = hw.adc.GetFloat(1); // Knob 2: LFO Depth

  float lfo_rate = 0.5f + rate_knob * 15.0f;
  float lfo_depth = depth_knob;

  lfo.SetFreq(lfo_rate);

  for (size_t i = 0; i < size; i++) {
    float lfo_sig = lfo.Process();
    float mod = 1.0f - lfo_depth * 0.5f * (1.0f + lfo_sig);
    float audio = audio_osc.Process();
    float sig = audio * mod;
    out[0][i] = sig;
    out[1][i] = sig;
  }
}

int main(void) {
  hw.Init();
  hw.SetAudioBlockSize(48);
  float sr = hw.AudioSampleRate();

  AdcChannelConfig adc_cfg[2];
  adc_cfg[0].InitSingle(seed::A0);
  adc_cfg[1].InitSingle(seed::A1);
  hw.adc.Init(adc_cfg, 2);
  hw.adc.Start();

  lfo.Init(sr);
  lfo.SetWaveform(Oscillator::WAVE_SIN);
  lfo.SetFreq(5.0f);
  lfo.SetAmp(1.0f);

  audio_osc.Init(sr);
  audio_osc.SetWaveform(Oscillator::WAVE_SAW);
  audio_osc.SetFreq(220.0f);
  audio_osc.SetAmp(0.6f);

  hw.StartAudio(AudioCallback);
  while (1) {}
}
`,
  },
};
