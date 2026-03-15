// Patch Evolver — genetic algorithm-style patch evolution through AI-guided mutation.
// Manages variant slots, generation tracking, and user selection.

/**
 * PatchEvolver manages the evolution workflow:
 * 1. User starts from a base patch
 * 2. AI generates N variants with musically-intelligent mutations
 * 3. User picks favorites
 * 4. AI breeds next generation from favorites
 */
export class PatchEvolver {
  constructor() {
    this.active = false;
    this.generation = 0;
    this.basePatch = null;
    this.variants = []; // Array of { code, label, compiled, wasmBytes, selected }
    this.maxVariants = 4;
    this.history = []; // Previous generations for undo
  }

  /**
   * Start evolution from a base patch.
   * @param {string} code - The starting C++ code
   */
  start(code) {
    this.active = true;
    this.generation = 0;
    this.basePatch = code;
    this.variants = [];
    this.history = [];
  }

  /**
   * Stop evolution and return to normal mode.
   */
  stop() {
    this.active = false;
    this.variants = [];
    this.history = [];
  }

  /**
   * Set variants for the current generation (called after LLM response).
   * @param {Array<{code: string, label: string}>} newVariants
   */
  setVariants(newVariants) {
    this.generation++;
    this.variants = newVariants.map((v, i) => ({
      code: v.code,
      label: v.label || `Variant ${String.fromCharCode(65 + i)}`,
      compiled: false,
      wasmBytes: null,
      selected: false,
      slot: i,
    }));
  }

  /**
   * Toggle selection of a variant for breeding.
   */
  toggleSelection(index) {
    if (index >= 0 && index < this.variants.length) {
      this.variants[index].selected = !this.variants[index].selected;
    }
  }

  /**
   * Get selected variants for the next breeding round.
   */
  getSelectedVariants() {
    return this.variants.filter(v => v.selected);
  }

  /**
   * Get the number of selected variants.
   */
  get selectionCount() {
    return this.variants.filter(v => v.selected).length;
  }

  /**
   * Mark a variant as compiled with its WASM bytes.
   */
  markCompiled(index, wasmBytes) {
    if (index >= 0 && index < this.variants.length) {
      this.variants[index].compiled = true;
      this.variants[index].wasmBytes = wasmBytes;
    }
  }

  /**
   * Build the LLM prompt for generating initial variants.
   */
  buildEvolvePrompt() {
    return `EVOLVE MODE: Generate exactly 4 variations of the current patch.

For each variation, make musically-interesting changes to parameters. Good mutations include:
- Shift frequencies (octave up/down, detune, harmonic ratios)
- Change waveforms (saw→square, sine→triangle, etc.)
- Alter filter cutoff/resonance ranges
- Modify envelope times (snappy vs. slow)
- Adjust mix levels and effects sends
- Change modulation depths and rates
- Swap DSP modules (SVF→MoogLadder, Chorus→Flanger)

Keep each variation COMPILABLE and COMPLETE. Don't break the core structure.

Return your response as a \`\`\`variants block with exactly 4 variations:

\`\`\`variants
--- Variant A: [short description of changes]
[complete C++ code]
--- Variant B: [short description of changes]
[complete C++ code]
--- Variant C: [short description of changes]
[complete C++ code]
--- Variant D: [short description of changes]
[complete C++ code]
\`\`\`

Make each variant distinctly different but musically coherent.`;
  }

  /**
   * Build the LLM prompt for breeding selected variants.
   */
  buildBreedPrompt() {
    const selected = this.getSelectedVariants();
    if (selected.length === 0) return null;

    let prompt = `EVOLVE MODE — BREED Generation ${this.generation + 1}:
The user selected ${selected.length} favorite(s) from the previous generation.
Breed 4 new variations that combine and mutate the best traits of the selected patches.

SELECTED PATCHES:\n\n`;

    for (const v of selected) {
      prompt += `--- ${v.label}\n\`\`\`cpp\n${v.code}\n\`\`\`\n\n`;
    }

    prompt += `Generate 4 new variations that:
- Combine interesting elements from the selected patches
- Introduce new mutations for further exploration
- Keep the overall character while pushing boundaries

Return as a \`\`\`variants block (same format as before).`;

    return prompt;
  }

  /**
   * Parse a ```variants block from the LLM response.
   * @param {string} text - Full LLM response
   * @returns {Array<{code: string, label: string}>|null}
   */
  static parseVariantsBlock(text) {
    const match = text.match(/```variants\s*\n([\s\S]*?)```/);
    if (!match) return null;

    const content = match[1];
    const variants = [];

    // Split by --- Variant headers
    const sections = content.split(/^---\s*Variant\s*[A-Z]:\s*/m);

    for (let i = 1; i < sections.length; i++) {
      const section = sections[i].trim();
      if (!section) continue;

      // First line is the description, rest is code
      const lines = section.split('\n');
      const label = `Variant ${String.fromCharCode(64 + i)}: ${lines[0].trim()}`;

      // Extract code — might be in a cpp fence or just raw
      const codeMatch = section.match(/```(?:cpp)?\s*\n([\s\S]*?)```/);
      const code = codeMatch ? codeMatch[1].trim() : lines.slice(1).join('\n').trim();

      if (code) {
        variants.push({ code, label });
      }
    }

    return variants.length > 0 ? variants : null;
  }

  /**
   * Get evolution state for display.
   */
  getState() {
    return {
      active: this.active,
      generation: this.generation,
      variants: this.variants.map(v => ({
        label: v.label,
        compiled: v.compiled,
        selected: v.selected,
        slot: v.slot,
      })),
      selectionCount: this.selectionCount,
    };
  }
}
