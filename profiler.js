// Performance Profiler — estimates CPU and memory usage on Daisy hardware
// by parsing C++ code for known DaisySP module instantiations.

// CPU cycle estimates per audio sample for DaisySP modules.
// Based on ARM Cortex-M7 @ 480MHz, 48kHz sample rate.
// Budget: 480MHz / 48kHz = 10,000 cycles per sample.
const MODULE_COSTS = {
  // Synthesis — cycles per Process() call
  'Oscillator':        { cycles: 25,  ram: 32,  category: 'synthesis' },
  'VariableSawOscillator': { cycles: 20, ram: 24, category: 'synthesis' },
  'VariableShapeOscillator': { cycles: 30, ram: 32, category: 'synthesis' },
  'FormantOscillator': { cycles: 35,  ram: 48,  category: 'synthesis' },
  'HarmonicOscillator':{ cycles: 80,  ram: 256, category: 'synthesis' },
  'OscillatorBank':    { cycles: 120, ram: 512, category: 'synthesis' },
  'ZOscillator':       { cycles: 40,  ram: 48,  category: 'synthesis' },
  'VosimOscillator':   { cycles: 30,  ram: 32,  category: 'synthesis' },
  'FM2':               { cycles: 50,  ram: 64,  category: 'synthesis' },
  'StringVoice':       { cycles: 150, ram: 2048, category: 'synthesis' },
  'ModalVoice':        { cycles: 120, ram: 1024, category: 'synthesis' },

  // Noise
  'WhiteNoise':        { cycles: 5,   ram: 8,   category: 'noise' },
  'Dust':              { cycles: 10,  ram: 16,  category: 'noise' },
  'ClockedNoise':      { cycles: 15,  ram: 24,  category: 'noise' },
  'GrainletOscillator':{ cycles: 60,  ram: 128, category: 'noise' },
  'Particle':          { cycles: 40,  ram: 64,  category: 'noise' },
  'FractalRandomGenerator': { cycles: 20, ram: 32, category: 'noise' },

  // Filters — cycles per Process() call
  'Svf':               { cycles: 40,  ram: 32,  category: 'filter' },
  'MoogLadder':        { cycles: 80,  ram: 48,  category: 'filter' },
  'OnePole':           { cycles: 10,  ram: 16,  category: 'filter' },
  'Biquad':            { cycles: 20,  ram: 32,  category: 'filter' },
  'Tone':              { cycles: 10,  ram: 16,  category: 'filter' },
  'ATone':             { cycles: 10,  ram: 16,  category: 'filter' },
  'NlFilt':            { cycles: 30,  ram: 32,  category: 'filter' },
  'Soap':              { cycles: 25,  ram: 32,  category: 'filter' },
  'FormantFilter':     { cycles: 50,  ram: 64,  category: 'filter' },

  // Effects
  'ReverbSc':          { cycles: 200, ram: 65536, category: 'effect' },
  'Chorus':            { cycles: 60,  ram: 8192,  category: 'effect' },
  'Flanger':           { cycles: 50,  ram: 4096,  category: 'effect' },
  'Phaser':            { cycles: 80,  ram: 256,   category: 'effect' },
  'PitchShifter':      { cycles: 150, ram: 32768, category: 'effect' },
  'Overdrive':         { cycles: 15,  ram: 16,    category: 'effect' },
  'Decimator':         { cycles: 10,  ram: 16,    category: 'effect' },
  'SampleRateReducer': { cycles: 8,   ram: 16,    category: 'effect' },
  'Wavefolder':        { cycles: 20,  ram: 16,    category: 'effect' },
  'Tremolo':           { cycles: 25,  ram: 32,    category: 'effect' },
  'Autowah':           { cycles: 35,  ram: 48,    category: 'effect' },
  'Compressor':        { cycles: 30,  ram: 32,    category: 'effect' },
  'Limiter':           { cycles: 20,  ram: 16,    category: 'effect' },
  'DcBlock':           { cycles: 5,   ram: 8,     category: 'utility' },
  'Fold':              { cycles: 10,  ram: 8,     category: 'effect' },
  'Bitcrush':          { cycles: 8,   ram: 8,     category: 'effect' },

  // Drums
  'AnalogBassDrum':    { cycles: 60,  ram: 128,  category: 'drum' },
  'AnalogSnareDrum':   { cycles: 70,  ram: 128,  category: 'drum' },
  'SyntheticBassDrum': { cycles: 50,  ram: 96,   category: 'drum' },
  'SyntheticSnareDrum':{ cycles: 60,  ram: 96,   category: 'drum' },
  'HiHat':             { cycles: 50,  ram: 128,  category: 'drum' },

  // Physical modeling
  'String':            { cycles: 80,  ram: 4096,  category: 'physical' },
  'Pluck':             { cycles: 60,  ram: 4096,  category: 'physical' },
  'Drip':              { cycles: 100, ram: 256,   category: 'physical' },
  'Resonator':         { cycles: 120, ram: 512,   category: 'physical' },
  'KarplusString':     { cycles: 80,  ram: 4096,  category: 'physical' },

  // Envelopes / Control
  'Adsr':              { cycles: 15,  ram: 32,  category: 'control' },
  'AdEnv':             { cycles: 10,  ram: 24,  category: 'control' },
  'Line':              { cycles: 5,   ram: 16,  category: 'control' },
  'Phasor':            { cycles: 5,   ram: 16,  category: 'control' },
  'Metro':             { cycles: 5,   ram: 16,  category: 'control' },
  'Maytrig':           { cycles: 5,   ram: 16,  category: 'control' },
  'SmoothRandomGenerator': { cycles: 10, ram: 16, category: 'control' },

  // Sampling
  'Looper':            { cycles: 20,  ram: 256,  category: 'sampling' },
  'GranularPlayer':    { cycles: 100, ram: 1024, category: 'sampling' },
};

// SDRAM threshold — DelayLine > this needs DSY_SDRAM_BSS
const SDRAM_DELAY_THRESHOLD = 24000;

// Daisy hardware specs
const DAISY_SPECS = {
  cpuFreqHz: 480_000_000,
  sampleRate: 48000,
  cyclesPerSample: 10000, // 480MHz / 48kHz
  sramBytes: 512 * 1024,  // 512KB internal SRAM
  sdramBytes: 64 * 1024 * 1024, // 64MB external SDRAM
  flashBytes: 128 * 1024, // 128KB internal flash (ITCM)
};

/**
 * Profile a C++ source file (or multiple files) and estimate resource usage.
 * @param {string|Object} source - Single string of C++ code, or {filename: content} object
 * @returns {Object} Profile results
 */
export function profileCode(source) {
  // Normalize to single string
  const code = typeof source === 'string'
    ? source
    : Object.values(source).join('\n');

  const modules = findModuleInstances(code);
  const delayLines = findDelayLines(code);
  const sdramVars = findSDRAMVariables(code);

  // Calculate totals
  let totalCycles = 0;
  let totalRAM = 0;
  const breakdown = [];

  for (const mod of modules) {
    totalCycles += mod.cycles;
    totalRAM += mod.ram;
    breakdown.push({
      name: mod.name,
      type: mod.type,
      cycles: mod.cycles,
      ram: mod.ram,
      category: mod.category,
    });
  }

  // Delay line memory
  let delayRAM = 0;
  let delaySdRAM = 0;
  for (const dl of delayLines) {
    const bytes = dl.samples * 4; // float = 4 bytes
    if (dl.sdram) {
      delaySdRAM += bytes;
    } else {
      delayRAM += bytes;
    }
    totalCycles += 5; // ~5 cycles per delay read
  }

  totalRAM += delayRAM;

  // SDRAM from explicit DSY_SDRAM_BSS
  let sdramUsage = delaySdRAM;
  for (const sv of sdramVars) {
    sdramUsage += sv.estimatedBytes;
  }

  const cpuPercent = (totalCycles / DAISY_SPECS.cyclesPerSample) * 100;
  const sramPercent = (totalRAM / DAISY_SPECS.sramBytes) * 100;
  const sdramPercent = (sdramUsage / DAISY_SPECS.sdramBytes) * 100;

  const warnings = [];
  if (cpuPercent > 80) warnings.push(`CPU usage is high (${cpuPercent.toFixed(0)}%) — may cause audio glitches`);
  if (cpuPercent > 100) warnings.push('CPU budget exceeded — this patch will NOT run in real-time');
  if (sramPercent > 80) warnings.push(`SRAM usage is high (${sramPercent.toFixed(0)}%)`);
  for (const dl of delayLines) {
    if (dl.samples > SDRAM_DELAY_THRESHOLD && !dl.sdram) {
      warnings.push(`DelayLine with ${dl.samples} samples should use DSY_SDRAM_BSS`);
    }
  }

  return {
    cpu: {
      cyclesPerSample: totalCycles,
      budget: DAISY_SPECS.cyclesPerSample,
      percent: parseFloat(cpuPercent.toFixed(1)),
    },
    sram: {
      bytes: totalRAM,
      total: DAISY_SPECS.sramBytes,
      percent: parseFloat(sramPercent.toFixed(1)),
    },
    sdram: {
      bytes: sdramUsage,
      total: DAISY_SPECS.sdramBytes,
      percent: parseFloat(sdramPercent.toFixed(2)),
    },
    modules: breakdown,
    delayLines,
    warnings,
    summary: formatSummary(cpuPercent, totalRAM, sdramUsage, modules.length),
  };
}

/**
 * Format a one-line summary for the status bar.
 */
function formatSummary(cpuPercent, sramBytes, sdramBytes, moduleCount) {
  const cpu = cpuPercent.toFixed(0);
  const sram = sramBytes < 1024 ? `${sramBytes}B` : `${(sramBytes / 1024).toFixed(1)}KB`;
  const sdram = sdramBytes > 0
    ? (sdramBytes < 1024 * 1024 ? `${(sdramBytes / 1024).toFixed(1)}KB` : `${(sdramBytes / (1024 * 1024)).toFixed(1)}MB`)
    : '0';
  return `CPU: ~${cpu}% | SRAM: ~${sram} | SDRAM: ${sdram} | ${moduleCount} modules`;
}

/**
 * Find DaisySP module declarations/instantiations in code.
 */
function findModuleInstances(code) {
  const instances = [];

  for (const [typeName, info] of Object.entries(MODULE_COSTS)) {
    // Match declarations like: Oscillator osc; or static Oscillator osc;
    const declRegex = new RegExp(`\\b${typeName}\\s+\\w+`, 'g');
    let match;
    while ((match = declRegex.exec(code)) !== null) {
      instances.push({
        name: match[0].trim(),
        type: typeName,
        cycles: info.cycles,
        ram: info.ram,
        category: info.category,
      });
    }
  }

  return instances;
}

/**
 * Find DelayLine instantiations and their sizes.
 */
function findDelayLines(code) {
  const delays = [];

  // Match: DelayLine<float, SIZE> or static DelayLine<float, SIZE>
  const regex = /DelayLine\s*<\s*float\s*,\s*(\d+)\s*>/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    const samples = parseInt(match[1]);
    const sdram = isInSDRAMContext(code, match.index);
    delays.push({ samples, sdram, bytes: samples * 4 });
  }

  return delays;
}

/**
 * Check if a code position is preceded by DSY_SDRAM_BSS.
 */
function isInSDRAMContext(code, position) {
  // Look backwards from position for DSY_SDRAM_BSS on the same line or previous line
  const before = code.substring(Math.max(0, position - 200), position);
  return before.includes('DSY_SDRAM_BSS');
}

/**
 * Find variables explicitly marked with DSY_SDRAM_BSS.
 */
function findSDRAMVariables(code) {
  const vars = [];
  const regex = /DSY_SDRAM_BSS\s+(\w+[\s\S]*?);/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    // Rough size estimate — look for array sizes
    const arrayMatch = match[1].match(/\[(\d+)\]/);
    const estimatedBytes = arrayMatch ? parseInt(arrayMatch[1]) * 4 : 4096;
    vars.push({ declaration: match[0].trim(), estimatedBytes });
  }
  return vars;
}

/**
 * Get the profiler context string for LLM injection.
 */
export function getProfileContext(source) {
  const profile = profileCode(source);
  let ctx = `PERFORMANCE PROFILE: ${profile.summary}`;
  if (profile.warnings.length > 0) {
    ctx += '\nWARNINGS: ' + profile.warnings.join('; ');
  }
  return ctx;
}

/**
 * Get the MODULE_COSTS table as a reference string for system prompt.
 */
export function getCycleReferenceTable() {
  let table = 'DaisySP MODULE CYCLE COSTS (per sample at 48kHz, budget: 10,000 cycles/sample):\n';
  const categories = {};
  for (const [name, info] of Object.entries(MODULE_COSTS)) {
    if (!categories[info.category]) categories[info.category] = [];
    categories[info.category].push({ name, ...info });
  }
  for (const [cat, mods] of Object.entries(categories)) {
    table += `  ${cat}: `;
    table += mods.map(m => `${m.name}(~${m.cycles})`).join(', ');
    table += '\n';
  }
  return table;
}
