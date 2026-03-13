// daisy-gpt browser edition — conversational agent interface
// No framework, no build step. Pure vanilla JS.

import { skills, skillNames } from './skills/index.js';
import { DAISYSP_REFERENCE } from './reference/daisysp_ref.js';
import { DaisyDFU, isWebUSBSupported, isChromeBrowser } from './dfu.js';
import { PROVIDERS, getApiKey, setApiKey, migrateOldKey, getOllamaUrl, setOllamaUrl } from './providers.js';
import { MIDIController } from './midi.js';
import { WasmClangCompiler } from './compiler.js';

// ─── State ─────────────────────────────────────────────────────────

const state = {
  provider: localStorage.getItem('daisy-gpt-provider') || 'anthropic',
  model: localStorage.getItem('daisy-gpt-model') || 'claude-opus-4-6',
  skill: localStorage.getItem('daisy-gpt-skill') || '',
  code: '',
  previousCode: '',
  isGenerating: false,
  isCompiling: false,
  isPlaying: false,
  compiled: false,
  wasmBytes: null,
  audioContext: null,
  workletNode: null,
  knobs: [0.5, 0.5, 0.5, 0.5],
  knobLabels: ['Knob 1', 'Knob 2', 'Knob 3', 'Knob 4'],
  rmsLevel: 0,
  history: JSON.parse(localStorage.getItem('daisy-gpt-history') || '[]'),
  compileRetries: 0,
  maxCompileRetries: 3,
  midi: null,
  midiConnected: false,
  // Conversation state
  messages: [],
  streamingMessageEl: null,
  streamingContent: '',
  abortController: null,
  // Compiler
  compiler: new WasmClangCompiler(),
  compilerLoading: false,
  compiledWithClang: false,
  // File registry for VFS browser
  fileRegistry: new Map(),
  // Thinking / reasoning
  thinkingEnabled: localStorage.getItem('daisy-gpt-thinking') === 'true',
  thinkingBudget: parseInt(localStorage.getItem('daisy-gpt-thinking-budget')) || 10000,
  reasoningEffort: localStorage.getItem('daisy-gpt-reasoning-effort') || 'low',
  // Active tab
  activeTab: 'chat',
  // File viewer state
  viewingFile: null,
  // Audio input
  audioInputMode: 'none',
  audioInputStream: null,
  audioInputSourceNode: null,
  sampleBuffer: null,
  sampleFileName: '',
  samplePosition: 0,
  sampleLength: 0,
  samplePlaying: false,
  sampleLoop: true,
};

// ─── DOM References ────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are daisy-gpt, an expert DSP programming assistant for the Electro-Smith Daisy Patch platform using DaisySP.

You help users create, modify, and understand synth patches through conversation. You can:
- Generate complete C++ code for the Daisy Patch
- Explain what the code does and how it works
- Modify existing patches based on user requests
- Suggest improvements or creative ideas
- Answer questions about DaisySP, synthesis, and DSP

When providing code, wrap it in a \`\`\`cpp code fence. Your code must:
1. Include "daisy_patch.h" and "daisysp.h"
2. Use \`using namespace daisy; using namespace daisysp;\`
3. Declare a global \`DaisyPatch patch;\`
4. Implement \`void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size)\`
5. Implement \`int main(void)\` that calls \`patch.Init()\`, initializes DSP objects, and calls \`patch.StartAudio(AudioCallback)\`
6. Map the 4 knobs (CTRL_1 through CTRL_4) to meaningful parameters using \`patch.GetKnobValue(DaisyPatch::CTRL_N)\`
7. Use \`fmap()\` for knob scaling (with Mapping::LOG for frequency-like params)

IMPORTANT CODE CONSTRAINTS:
- Always include COMPLETE, COMPILABLE code in your \`\`\`cpp blocks — never partial snippets
- All DSP objects must be static globals (not on stack)
- Large DelayLines (>24000 samples) must use DSY_SDRAM_BSS
- Never allocate memory in AudioCallback
- Always call Process() every sample for envelopes/oscillators
- Use fclamp() to prevent out-of-range filter frequencies
- Keep output levels reasonable — use SoftClip() if mixing multiple sources
- Gate inputs: patch.gate_input[0].Trig() for trigger detection

After providing code, briefly explain what each knob controls.

EDIT COMMANDS:
When the user asks for a small change to existing code, prefer edit commands over full regeneration.
Use edit blocks for param tweaks, adding modules, fixing bugs, changing knob ranges.
Use full \`\`\`cpp code blocks for new patches or extensive rewrites (>50% of code changes).

Edit format — wrap each edit in a fenced \`\`\`edit block:
\`\`\`edit
--- patch.cpp
<<<<<<< SEARCH
exact lines to find in current code
=======
replacement lines
>>>>>>> REPLACE
\`\`\`

Rules:
- SEARCH text must match the current code exactly (including indentation)
- Include 1-2 context lines around the change for unique matching
- Empty REPLACE section = delete the matched lines
- Multiple edit blocks per response are fine, applied in order
- If you're unsure the match is unique, include more context lines

Be concise but helpful. Focus on being a great collaborator.

DaisySP REFERENCE:
${DAISYSP_REFERENCE}`;

// ─── Chat / LLM ───────────────────────────────────────────────────

function currentApiKey() {
  if (state.provider === 'ollama') return 'ollama';
  return getApiKey(state.provider);
}

async function sendMessage(userText) {
  if (!currentApiKey()) {
    showApiKeyModal();
    return;
  }
  if (state.isGenerating) return;

  state.isGenerating = true;
  state.compileRetries = 0;
  state.abortController = new AbortController();
  updateUI();

  // Add user message to conversation
  state.messages.push({ role: 'user', content: userText });
  appendChatBubble('user', userText);

  // Clear input
  const input = $('#chat-input');
  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Build system prompt with dynamic context
  let systemPrompt = SYSTEM_PROMPT;
  if (state.midiConnected) {
    systemPrompt = `MIDI KEYBOARD CONNECTED.
Available CV inputs in AudioCallback:
- daisy_pitch_cv: 1V/Oct pitch (C4=0.0, C5=1.0, C3=-1.0). Convert to Hz: cvToFreq(daisy_pitch_cv)
- daisy_gate[0]: true while note held
- daisy_velocity: note velocity 0.0-1.0
- daisy_pitchbend: pitch bend -1.0 to 1.0
Use cvToFreq() for frequency from MIDI pitch.\n\n` + systemPrompt;
  }
  if (state.skill && skills[state.skill]) {
    systemPrompt += `\n\nSKILL CONTEXT (use this as a guide for the requested patch type):\n${skills[state.skill]}`;
  }
  if (state.code) {
    systemPrompt += `\n\nCURRENT CODE (the user's active patch — reference or modify as needed):\n\`\`\`cpp\n${state.code}\n\`\`\``;
    if (state.code.split('\n').length > 20) {
      systemPrompt += '\nThe user has existing code. Prefer edit commands for small changes.';
    }
  }

  const provider = PROVIDERS[state.provider];
  if (!provider) {
    setStatus('error', `Unknown provider: ${state.provider}`);
    state.isGenerating = false;
    updateUI();
    return;
  }

  // Create streaming assistant bubble
  const assistantEl = appendChatBubble('assistant', '', true);
  state.streamingContent = '';
  state.streamingMessageEl = assistantEl;

  // Build thinking/reasoning options
  const callOptions = {};
  if (state.thinkingEnabled && modelSupportsThinking()) {
    callOptions.thinking = true;
    callOptions.budgetTokens = state.thinkingBudget;
    callOptions.reasoningEffort = getReasoningEffort();
    let thinkingContent = '';
    let thinkingEl = null;
    callOptions.onThinking = (token) => {
      if (!thinkingEl) {
        thinkingEl = createThinkingBlock(assistantEl);
      }
      thinkingContent += token;
      renderThinkingContent(thinkingEl, thinkingContent);
    };
  }

  try {
    await provider.call(currentApiKey(), state.model, systemPrompt, state.messages, (token) => {
      state.streamingContent += token;
      renderStreamingBubble(state.streamingMessageEl, state.streamingContent);
    }, state.abortController?.signal, callOptions);

    // Stream complete
    const fullResponse = state.streamingContent;
    state.messages.push({ role: 'assistant', content: fullResponse });
    finalizeAssistantBubble(state.streamingMessageEl, fullResponse);

    // Check for edits first, then full code blocks
    const edits = extractEditsFromResponse(fullResponse);
    const extractedCode = extractCodeFromResponse(fullResponse);

    if (edits.length > 0 && state.code) {
      // Apply edit commands
      const { code, results } = applyEdits(edits, state.code);
      const allOk = results.every(r => r.ok);

      if (allOk) {
        state.previousCode = state.code;
        state.code = code;
        extractKnobLabels(state.code);
        updateKnobLabels();
        syncCodeToEditor();
        flashTab('code');
        showToast(`${results.length} edit(s) applied`);
        addToHistory(userText, state.code);

        state.isGenerating = false;
        state.abortController = null;
        updateUI();
        await compileCode();
      } else {
        // Some edits failed — report in chat
        const failCount = results.filter(r => !r.ok).length;
        const errMsg = `${failCount} of ${results.length} edit(s) failed to match. `;
        const partial = results.some(r => r.ok);
        if (partial) {
          state.previousCode = state.code;
          state.code = code;
          extractKnobLabels(state.code);
          updateKnobLabels();
          syncCodeToEditor();
          flashTab('code');
          appendChatBubble('assistant', errMsg + 'Partial edits applied.');
        } else {
          appendChatBubble('assistant', errMsg + 'No changes applied.');
        }
        state.isGenerating = false;
        state.abortController = null;
        updateUI();
        if (partial) await compileCode();
      }
    } else if (extractedCode) {
      state.previousCode = state.code;
      state.code = extractedCode;
      extractKnobLabels(state.code);
      updateKnobLabels();
      syncCodeToEditor();
      flashTab('code');
      addToHistory(userText, state.code);

      state.isGenerating = false;
      state.abortController = null;
      updateUI();
      await compileCode();
    } else {
      state.isGenerating = false;
      state.abortController = null;
      updateUI();
    }

  } catch (err) {
    state.isGenerating = false;
    state.abortController = null;
    if (err.name === 'AbortError') {
      // User stopped generation — finalize partial content
      const partial = state.streamingContent;
      if (partial) {
        state.messages.push({ role: 'assistant', content: partial });
        finalizeAssistantBubble(state.streamingMessageEl, partial + '\n\n*(stopped)*');
      } else {
        state.streamingMessageEl?.remove();
      }
      setStatus('info', 'Generation stopped');
    } else {
      const body = state.streamingMessageEl?.querySelector('.chat-message-body');
      if (body) body.textContent = `Error: ${err.message}`;
      state.streamingMessageEl?.classList.remove('streaming');
      setStatus('error', `API Error: ${err.message}`);
    }
    updateUI();
  }
}

function extractCodeFromResponse(text) {
  const regex = /```(?:cpp|c\+\+)\s*\n([\s\S]*?)```/g;
  let lastMatch = null;
  let match;
  while ((match = regex.exec(text)) !== null) {
    lastMatch = match[1];
  }
  return lastMatch ? lastMatch.trim() : null;
}

// ─── Edit Parsing & Application ───────────────────────────────────

function extractEditsFromResponse(text) {
  const edits = [];
  const regex = /```edit\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    // Parse --- filename
    const fileMatch = block.match(/^---\s*(\S+)\s*$/m);
    const file = fileMatch ? fileMatch[1] : 'patch.cpp';

    // Parse SEARCH/REPLACE
    const srMatch = block.match(/<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/);
    if (srMatch) {
      edits.push({
        file,
        search: srMatch[1].replace(/\n$/, ''),
        replace: srMatch[2].replace(/\n$/, ''),
      });
    }
  }
  return edits;
}

function applyEdits(edits, code) {
  let current = code;
  const results = [];

  for (const edit of edits) {
    // Exact match first
    let idx = current.indexOf(edit.search);

    // Fuzzy fallback: normalize trailing whitespace per line
    if (idx === -1) {
      const normCode = current.split('\n').map(l => l.trimEnd()).join('\n');
      const normSearch = edit.search.split('\n').map(l => l.trimEnd()).join('\n');
      const normIdx = normCode.indexOf(normSearch);
      if (normIdx !== -1) {
        const beforeNorm = normCode.substring(0, normIdx);
        const linesBefore = beforeNorm.split('\n').length - 1;
        const origLines = current.split('\n');
        let origOffset = 0;
        for (let i = 0; i < linesBefore; i++) {
          origOffset += origLines[i].length + 1;
        }
        const searchLineCount = edit.search.split('\n').length;
        const origSearchLines = origLines.slice(linesBefore, linesBefore + searchLineCount);
        const origSearchText = origSearchLines.join('\n');
        current = current.substring(0, origOffset) + edit.replace + current.substring(origOffset + origSearchText.length);
        results.push({ ok: true, edit });
        continue;
      }
    }

    if (idx !== -1) {
      current = current.substring(0, idx) + edit.replace + current.substring(idx + edit.search.length);
      results.push({ ok: true, edit });
    } else {
      results.push({ ok: false, edit, reason: 'SEARCH text not found in code' });
    }
  }

  return { code: current, results };
}

// ─── Chat Rendering ───────────────────────────────────────────────

function appendChatBubble(role, content, streaming = false) {
  const container = $('#chat-messages');
  if (!container) return null;

  // Remove welcome screen
  const welcome = container.querySelector('.chat-welcome');
  if (welcome) welcome.remove();

  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}${streaming ? ' streaming' : ''}`;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'chat-message-role';
  roleLabel.textContent = role === 'user' ? 'You' : 'daisy-gpt';

  const body = document.createElement('div');
  body.className = 'chat-message-body';

  if (role === 'user') {
    body.textContent = content;
  } else if (!streaming) {
    body.innerHTML = renderMarkdown(content);
  }

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(body);
  container.appendChild(msgDiv);
  container.scrollTop = container.scrollHeight;

  return msgDiv;
}

function renderStreamingBubble(msgEl, rawText) {
  if (!msgEl) return;
  const body = msgEl.querySelector('.chat-message-body');
  if (!body) return;

  if (!msgEl._rafPending) {
    msgEl._rafPending = true;
    requestAnimationFrame(() => {
      body.innerHTML = renderMarkdown(rawText);
      msgEl._rafPending = false;
      const container = $('#chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }
}

// ─── Thinking / Reasoning ─────────────────────────────────────────

function modelSupportsThinking() {
  const provider = PROVIDERS[state.provider];
  if (!provider) return false;
  const model = provider.models.find(m => m.id === state.model);
  return !!(model?.thinking || model?.reasoning);
}

function getReasoningEffort() {
  return state.reasoningEffort || 'low';
}

function formatBudget(val) {
  return val >= 1000 ? Math.round(val / 1000) + 'k' : val;
}

function createThinkingBlock(msgEl) {
  const body = msgEl.querySelector('.chat-message-body');
  if (!body) return null;
  const details = document.createElement('details');
  details.className = 'thinking-block';
  details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = 'Thinking\u2026';
  const content = document.createElement('div');
  content.className = 'thinking-content';
  details.appendChild(summary);
  details.appendChild(content);
  body.appendChild(details);
  return details;
}

function renderThinkingContent(detailsEl, text) {
  if (!detailsEl) return;
  const content = detailsEl.querySelector('.thinking-content');
  if (!content) return;
  if (!detailsEl._rafPending) {
    detailsEl._rafPending = true;
    requestAnimationFrame(() => {
      content.textContent = text;
      detailsEl._rafPending = false;
      const container = $('#chat-messages');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }
}

function currentModelDef() {
  const provider = PROVIDERS[state.provider];
  if (!provider) return null;
  return provider.models.find(m => m.id === state.model) || null;
}

function updateThinkingControls() {
  const controls = $('#thinking-controls');
  const toggle = $('#thinking-toggle');
  const budgetControl = $('#budget-control');
  const effortControl = $('#effort-control');
  if (!controls) return;

  const supported = modelSupportsThinking();
  controls.classList.toggle('hidden', !supported);

  if (toggle) toggle.checked = state.thinkingEnabled;

  const model = currentModelDef();
  const isThinking = model?.thinking;
  const isReasoning = model?.reasoning;

  // Show budget slider for Anthropic thinking, effort dropdown for OpenAI reasoning
  if (budgetControl) budgetControl.classList.toggle('hidden', !(state.thinkingEnabled && isThinking));
  if (effortControl) effortControl.classList.toggle('hidden', !(state.thinkingEnabled && isReasoning));

  const budgetSlider = $('#thinking-budget');
  const budgetLabel = $('#budget-value');
  if (budgetSlider) budgetSlider.value = state.thinkingBudget;
  if (budgetLabel) budgetLabel.textContent = formatBudget(state.thinkingBudget);

  const effortSelect = $('#reasoning-effort');
  if (effortSelect) effortSelect.value = state.reasoningEffort;
}

function finalizeAssistantBubble(msgEl, fullText) {
  if (!msgEl) return;
  msgEl.classList.remove('streaming');
  const body = msgEl.querySelector('.chat-message-body');
  if (!body) return;

  body.innerHTML = renderMarkdown(fullText);

  // Syntax highlight code blocks
  body.querySelectorAll('pre code').forEach(block => {
    if (window.hljs) hljs.highlightElement(block);
  });

  // Add action buttons to cpp code blocks
  body.querySelectorAll('pre code.language-cpp').forEach(block => {
    const actions = document.createElement('div');
    actions.className = 'code-block-actions';

    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(block.textContent);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => copyBtn.textContent = 'Copy', 1500);
    });

    const useBtn = document.createElement('button');
    useBtn.textContent = 'Use this code';
    useBtn.addEventListener('click', () => {
      state.previousCode = state.code;
      state.code = block.textContent;
      extractKnobLabels(state.code);
      updateKnobLabels();
      syncCodeToEditor();
      switchTab('code');
      updateUI();
      compileCode();
    });

    actions.appendChild(copyBtn);
    actions.appendChild(useBtn);
    block.closest('pre').after(actions);
  });

  const container = $('#chat-messages');
  if (container) container.scrollTop = container.scrollHeight;
}

// ─── Markdown Renderer (lightweight) ──────────────────────────────

function renderMarkdown(text) {
  // Protect code fences (including edit blocks)
  const codeBlocks = [];
  let processed = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code });
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Escape HTML
  processed = escapeHtml(processed);

  // Inline code
  processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Paragraphs
  processed = processed.split(/\n\n+/).map(p => {
    p = p.trim();
    if (!p || p.startsWith('\x00CODEBLOCK')) return p;
    return `<p>${p.replace(/\n/g, '<br>')}</p>`;
  }).join('\n');

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => {
    const { lang, code } = codeBlocks[parseInt(idx)];

    // Render edit blocks as diff views
    if (lang === 'edit') {
      return renderEditBlock(code);
    }

    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langClass}>${escapeHtml(code)}</code></pre>`;
  });

  return processed;
}

function renderEditBlock(code) {
  const fileMatch = code.match(/^---\s*(\S+)\s*$/m);
  const file = fileMatch ? fileMatch[1] : 'patch.cpp';

  const srMatch = code.match(/<<<<<<< SEARCH\n([\s\S]*?)=======\n([\s\S]*?)>>>>>>> REPLACE/);
  if (!srMatch) {
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }

  const searchLines = srMatch[1].replace(/\n$/, '').split('\n');
  const replaceLines = srMatch[2].replace(/\n$/, '').split('\n');

  let diffHtml = '<div class="edit-diff-block">';
  diffHtml += `<div class="edit-diff-header"><span>${escapeHtml(file)}</span></div>`;
  diffHtml += '<div class="edit-diff-body">';

  for (const line of searchLines) {
    diffHtml += `<div class="edit-diff-line remove">${escapeHtml(line)}</div>`;
  }
  // Show replace lines only if non-empty (empty = deletion)
  const hasReplace = replaceLines.length > 1 || replaceLines[0] !== '';
  if (hasReplace) {
    for (const line of replaceLines) {
      diffHtml += `<div class="edit-diff-line add">${escapeHtml(line)}</div>`;
    }
  }

  diffHtml += '</div>';
  diffHtml += '<div class="edit-diff-actions">';
  diffHtml += `<button onclick="window._applyEditFromChat(this)" data-search="${btoa(encodeURIComponent(srMatch[1].replace(/\n$/, '')))}" data-replace="${btoa(encodeURIComponent(srMatch[2].replace(/\n$/, '')))}">Apply edit</button>`;
  diffHtml += '</div>';
  diffHtml += '</div>';

  return diffHtml;
}

function extractKnobLabels(code) {
  const labels = ['Knob 1', 'Knob 2', 'Knob 3', 'Knob 4'];
  const patterns = [
    /CTRL_1[^;]*?\/\/\s*(.+)/i,
    /CTRL_2[^;]*?\/\/\s*(.+)/i,
    /CTRL_3[^;]*?\/\/\s*(.+)/i,
    /CTRL_4[^;]*?\/\/\s*(.+)/i,
  ];

  for (let i = 0; i < 4; i++) {
    const match = code.match(patterns[i]);
    if (match) labels[i] = match[1].trim().substring(0, 20);
  }

  const knobMapPattern = /(?:CTRL_|Knob\s*|knob\s*)(\d)[^]*?fmap\([^,]+,\s*[^)]+\);\s*\/\/\s*(.+)/gi;
  let m;
  while ((m = knobMapPattern.exec(code)) !== null) {
    const idx = parseInt(m[1]) - 1;
    if (idx >= 0 && idx < 4) labels[idx] = m[2].trim().substring(0, 20);
  }

  state.knobLabels = labels;
}

// ─── Compiler ──────────────────────────────────────────────────────

async function compileCode() {
  if (!state.code) return;

  state.isCompiling = true;
  state.compiled = false;
  state.compiledWithClang = false;
  setStatus('compiling', 'Compiling...');
  updateUI();

  const startTime = performance.now();

  const attemptingClang = state.compiler.loaded;

  try {
    // Try C++ compilation if compiler is loaded
    if (attemptingClang) {
      state.wasmBytes = await compileWithWasmClang(state.code);
      state.compiledWithClang = true;
    } else {
      // Fallback: preview synth WASM
      state.wasmBytes = generatePreviewWasm(state.code);
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const mode = state.compiledWithClang ? 'Compiled C++' : 'Preview synth';
    state.compiled = true;
    state.isCompiling = false;
    setStatus('success', `${mode} (${elapsed}s)`);
    updateUI();

  } catch (err) {
    state.isCompiling = false;

    if (attemptingClang && state.compileRetries < state.maxCompileRetries) {
      state.compileRetries++;
      setStatus('compiling', `Compile error — auto-fixing (attempt ${state.compileRetries}/${state.maxCompileRetries})...`);
      await autoFixCompileError(err.message);
    } else if (!attemptingClang) {
      // Preview WASM shouldn't fail, but handle it
      setStatus('error', `Compile failed: ${err.message}`);
      updateUI();
    } else {
      // Max retries exhausted — fall back to preview synth
      try {
        state.wasmBytes = generatePreviewWasm(state.code);
        state.compiled = true;
        state.compiledWithClang = false;
        setStatus('warning', `C++ compile failed, using preview synth`);
      } catch {
        setStatus('error', `Compile failed: ${err.message}`);
      }
      updateUI();
    }
  }
}

async function compileWithWasmClang(code) {
  return await state.compiler.compile(code);
}

async function loadCompiler() {
  if (state.compiler.loaded || state.compilerLoading) return;
  state.compilerLoading = true;
  updateUI();

  try {
    await state.compiler.load((msg) => {
      setStatus('compiling', msg);
    });
    setStatus('success', 'Compiler cached and ready');
    populateFileRegistry();
    updateUI();

    // If we have code that was compiled as preview, recompile with C++
    if (state.code && state.compiled && !state.compiledWithClang) {
      state.compileRetries = 0;
      await compileCode();
    }
  } catch (err) {
    console.error('Compiler load failed:', err);
    setStatus('error', `Compiler load failed: ${err.message}`);
  } finally {
    state.compilerLoading = false;
    updateUI();
  }
}

function stopGeneration() {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
  // Also prevent auto-fix loop from continuing
  state.compileRetries = state.maxCompileRetries;
}

async function autoFixCompileError(errorMsg) {
  if (!currentApiKey()) return;
  if (state.abortController?.signal?.aborted) return;
  const editHint = state.code && state.code.split('\n').length > 20
    ? ' Use edit commands to fix just the broken parts rather than regenerating everything.'
    : '';
  const fixPrompt = `The code has a compile error:\n\n\`\`\`\n${errorMsg}\n\`\`\`\n\nPlease fix it.${editHint}`;
  await sendMessage(fixPrompt);
}

// Generate a preview WASM module that produces a simple synth
function generatePreviewWasm(cppCode) {
  return buildSynthWasm();
}

// Build a minimal WASM binary for a dual-saw synth with filter
function buildSynthWasm() {
  const b = new WasmBuilder();

  b.typeSection([
    { params: [0x7D], results: [] },
    { params: [], results: [0x7D] },
    { params: [0x7F, 0x7D], results: [] },
    { params: [0x7F, 0x7F], results: [] },
  ]);

  b.functionSection([0, 1, 2, 3]);
  b.memorySection(1, 1);

  b.globalSection([
    { type: 0x7D, mutable: true, init: 48000 },
    { type: 0x7D, mutable: true, init: 0 },
    { type: 0x7D, mutable: true, init: 0 },
    { type: 0x7D, mutable: true, init: 0 },
    { type: 0x7D, mutable: true, init: 0.5 },
    { type: 0x7D, mutable: true, init: 0.5 },
    { type: 0x7D, mutable: true, init: 0.5 },
    { type: 0x7D, mutable: true, init: 0.5 },
    { type: 0x7F, mutable: true, initI32: 0 },
    { type: 0x7F, mutable: true, initI32: 0 },
    { type: 0x7D, mutable: true, init: 0 },
    { type: 0x7D, mutable: true, init: 0 },
  ]);

  b.exportSection([
    { name: 'memory', kind: 2, index: 0 },
    { name: 'init', kind: 0, index: 0 },
    { name: 'processSample', kind: 0, index: 1 },
    { name: 'setKnob', kind: 0, index: 2 },
    { name: 'setGate', kind: 0, index: 3 },
  ]);

  b.codeSection([
    buildInitFunction(),
    buildProcessSampleBytes(),
    buildSetKnobFunction(),
    buildSetGateFunction(),
  ]);

  return b.toBytes();
}

// WASM binary builder helper
class WasmBuilder {
  constructor() { this.sections = []; }

  _encodeString(str) {
    const bytes = new TextEncoder().encode(str);
    return [...this._leb128(bytes.length), ...bytes];
  }

  _leb128(value) {
    const result = [];
    do {
      let byte = value & 0x7F;
      value >>= 7;
      if (value !== 0) byte |= 0x80;
      result.push(byte);
    } while (value !== 0);
    return result;
  }

  _leb128Signed(value) {
    const result = [];
    let more = true;
    while (more) {
      let byte = value & 0x7F;
      value >>= 7;
      if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      result.push(byte);
    }
    return result;
  }

  _f32Bytes(value) {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    return [...new Uint8Array(buf)];
  }

  typeSection(types) {
    const content = [types.length];
    for (const t of types) {
      content.push(0x60);
      content.push(t.params.length, ...t.params);
      content.push(t.results.length, ...t.results);
    }
    this.sections.push({ id: 1, content });
  }

  functionSection(typeIndices) {
    this.sections.push({ id: 3, content: [typeIndices.length, ...typeIndices] });
  }

  memorySection(min, max) {
    this.sections.push({ id: 5, content: [1, 1, min, max] });
  }

  globalSection(globals) {
    const content = [globals.length];
    for (const g of globals) {
      content.push(g.type, g.mutable ? 1 : 0);
      if (g.type === 0x7D) {
        content.push(0x43, ...this._f32Bytes(g.init || 0));
      } else {
        content.push(0x41, ...this._leb128Signed(g.initI32 || 0));
      }
      content.push(0x0B);
    }
    this.sections.push({ id: 6, content });
  }

  exportSection(exports) {
    const content = [exports.length];
    for (const e of exports) {
      content.push(...this._encodeString(e.name));
      content.push(e.kind, ...this._leb128(e.index));
    }
    this.sections.push({ id: 7, content });
  }

  codeSection(functions) {
    const content = [functions.length];
    for (const fn of functions) {
      const size = this._leb128(fn.length);
      content.push(...size, ...fn);
    }
    this.sections.push({ id: 10, content });
  }

  toBytes() {
    const parts = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
    for (const section of this.sections) {
      parts.push(section.id);
      const sizeBytes = this._leb128(section.content.length);
      parts.push(...sizeBytes, ...section.content);
    }
    return new Uint8Array(parts);
  }
}

function buildInitFunction() {
  return new Uint8Array([
    0,
    0x20, 0x00, 0x24, 0x00,
    0x43, ...f32(0), 0x24, 0x01,
    0x43, ...f32(0), 0x24, 0x02,
    0x43, ...f32(0), 0x24, 0x03,
    0x43, ...f32(0), 0x24, 0x0A,
    0x43, ...f32(0), 0x24, 0x0B,
    0x0B,
  ]);
}

function buildProcessSampleBytes() {
  const b = [];
  b.push(1, 4, 0x7D);

  b.push(0x43, ...f32(50));
  b.push(0x23, 0x04);
  b.push(0x23, 0x04);
  b.push(0x94);
  b.push(0x43, ...f32(1950));
  b.push(0x94);
  b.push(0x92);
  b.push(0x21, 0x00);

  b.push(0x20, 0x00);
  b.push(0x23, 0x00);
  b.push(0x95);
  b.push(0x21, 0x01);

  b.push(0x23, 0x01);
  b.push(0x20, 0x01);
  b.push(0x92);
  b.push(0x21, 0x02);
  b.push(0x20, 0x02);
  b.push(0x20, 0x02);
  b.push(0x8C);
  b.push(0x93);
  b.push(0x24, 0x01);

  b.push(0x23, 0x01);
  b.push(0x43, ...f32(2));
  b.push(0x94);
  b.push(0x43, ...f32(1));
  b.push(0x93);
  b.push(0x21, 0x02);

  b.push(0x20, 0x00);
  b.push(0x43, ...f32(1));
  b.push(0x23, 0x05);
  b.push(0x43, ...f32(0.02));
  b.push(0x94);
  b.push(0x92);
  b.push(0x94);
  b.push(0x23, 0x00);
  b.push(0x95);
  b.push(0x23, 0x02);
  b.push(0x92);
  b.push(0x21, 0x03);
  b.push(0x20, 0x03);
  b.push(0x20, 0x03);
  b.push(0x8C);
  b.push(0x93);
  b.push(0x24, 0x02);

  b.push(0x20, 0x02);
  b.push(0x23, 0x02);
  b.push(0x43, ...f32(2));
  b.push(0x94);
  b.push(0x43, ...f32(1));
  b.push(0x93);
  b.push(0x92);
  b.push(0x43, ...f32(0.25));
  b.push(0x94);
  b.push(0x21, 0x02);

  b.push(0x23, 0x0A);
  b.push(0x43, ...f32(100));
  b.push(0x23, 0x06);
  b.push(0x23, 0x06);
  b.push(0x94);
  b.push(0x43, ...f32(7900));
  b.push(0x94);
  b.push(0x92);
  b.push(0x23, 0x00);
  b.push(0x95);
  b.push(0x43, ...f32(0.99));
  b.push(0x97);
  b.push(0x20, 0x02);
  b.push(0x23, 0x0A);
  b.push(0x93);
  b.push(0x94);
  b.push(0x92);
  b.push(0x24, 0x0A);
  b.push(0x23, 0x0A);
  b.push(0x21, 0x03);

  b.push(0x23, 0x03);
  b.push(0x43, ...f32(0.0003));
  b.push(0x23, 0x0B);
  b.push(0x23, 0x03);
  b.push(0x93);
  b.push(0x94);
  b.push(0x92);
  b.push(0x24, 0x03);

  b.push(0x23, 0x0B);
  b.push(0x43, ...f32(0.9999));
  b.push(0x94);
  b.push(0x24, 0x0B);

  b.push(0x20, 0x03);
  b.push(0x43, ...f32(0.3));
  b.push(0x23, 0x03);
  b.push(0x43, ...f32(0.7));
  b.push(0x94);
  b.push(0x92);
  b.push(0x94);

  b.push(0x0B);
  return new Uint8Array(b);
}

function buildSetKnobFunction() {
  const b = [];
  b.push(0);
  for (let i = 0; i < 4; i++) {
    b.push(0x20, 0x00, 0x41, i, 0x46, 0x04, 0x40);
    b.push(0x20, 0x01, 0x24, 0x04 + i, 0x0B);
  }
  b.push(0x0B);
  return new Uint8Array(b);
}

function buildSetGateFunction() {
  const b = [];
  b.push(0);
  b.push(0x20, 0x00, 0x41, 0x00, 0x46, 0x04, 0x40);
  b.push(0x20, 0x01, 0x24, 0x08);
  b.push(0x20, 0x01, 0x04, 0x40);
  b.push(0x43, ...f32(1.0), 0x24, 0x0B);
  b.push(0x0B, 0x0B);
  b.push(0x20, 0x00, 0x41, 0x01, 0x46, 0x04, 0x40);
  b.push(0x20, 0x01, 0x24, 0x09, 0x0B);
  b.push(0x0B);
  return new Uint8Array(b);
}

function f32(value) {
  const buf = new ArrayBuffer(4);
  new Float32Array(buf)[0] = value;
  return [...new Uint8Array(buf)];
}

// ─── Audio Input ──────────────────────────────────────────────────

function switchAudioInputMode(mode) {
  disconnectAudioInput();
  state.audioInputMode = mode;

  const liveEl = document.getElementById('live-controls');
  const sampleEl = document.getElementById('sample-controls');
  if (liveEl) liveEl.classList.toggle('hidden', mode !== 'live');
  if (sampleEl) sampleEl.classList.toggle('hidden', mode !== 'sample');

  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'set-input-mode', mode });
  }

  if (mode === 'live') {
    enumerateAudioInputDevices();
  }
}

async function enumerateAudioInputDevices() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(d => d.kind === 'audioinput');

    const sel = document.getElementById('audio-in-device');
    if (!sel) return;
    // Clear and rebuild options
    while (sel.options.length > 0) sel.remove(0);
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'Select device...';
    sel.appendChild(defaultOpt);
    for (const dev of audioInputs) {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || ('Mic ' + sel.options.length);
      sel.appendChild(opt);
    }
  } catch (err) {
    console.warn('Could not enumerate audio devices:', err);
    setStatus('error', 'Mic access denied: ' + err.message);
  }
}

async function selectAudioInputDevice(deviceId) {
  disconnectAudioInput();
  if (!deviceId) return;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } }
    });
    state.audioInputStream = stream;

    if (state.audioContext && state.workletNode) {
      state.audioInputSourceNode = state.audioContext.createMediaStreamSource(stream);
      state.audioInputSourceNode.connect(state.workletNode);
    }
  } catch (err) {
    console.error('Failed to open audio input:', err);
    setStatus('error', 'Mic error: ' + err.message);
  }
}

function disconnectAudioInput() {
  if (state.audioInputSourceNode) {
    try { state.audioInputSourceNode.disconnect(); } catch (e) { /* ignore */ }
    state.audioInputSourceNode = null;
  }
  if (state.audioInputStream) {
    state.audioInputStream.getTracks().forEach(t => t.stop());
    state.audioInputStream = null;
  }
}

async function loadSampleFile(file) {
  try {
    if (!state.audioContext) {
      state.audioContext = new AudioContext({ sampleRate: 48000 });
    }
    const arrayBuf = await file.arrayBuffer();
    const audioBuf = await state.audioContext.decodeAudioData(arrayBuf);

    const left = audioBuf.getChannelData(0);
    const right = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : left;

    state.sampleBuffer = { left: new Float32Array(left), right: new Float32Array(right) };
    state.sampleFileName = file.name;
    state.sampleLength = left.length;
    state.samplePosition = 0;
    state.samplePlaying = false;

    const nameEl = document.getElementById('sample-file-name');
    if (nameEl) nameEl.textContent = file.name;
    const playBtn = document.getElementById('btn-sample-play');
    if (playBtn) playBtn.disabled = false;

    if (state.workletNode) {
      state.workletNode.port.postMessage({
        type: 'load-sample',
        left: state.sampleBuffer.left,
        right: state.sampleBuffer.right,
      });
    }
  } catch (err) {
    console.error('Failed to load sample:', err);
    setStatus('error', 'Sample load error: ' + err.message);
  }
}

function connectAudioInputToWorklet() {
  if (state.audioInputMode === 'live' && state.audioInputStream && state.audioContext && state.workletNode) {
    state.audioInputSourceNode = state.audioContext.createMediaStreamSource(state.audioInputStream);
    state.audioInputSourceNode.connect(state.workletNode);
  }

  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'set-input-mode', mode: state.audioInputMode });

    if (state.audioInputMode === 'sample' && state.sampleBuffer) {
      state.workletNode.port.postMessage({
        type: 'load-sample',
        left: state.sampleBuffer.left,
        right: state.sampleBuffer.right,
      });
      if (state.samplePlaying) {
        state.workletNode.port.postMessage({ type: 'sample-play', fromStart: false });
      }
    }

    state.workletNode.port.postMessage({ type: 'sample-loop', loop: state.sampleLoop });
  }
}

function updateSamplePositionUI(position, length) {
  const bar = document.getElementById('sample-position-bar');
  if (bar && length > 0) {
    bar.style.width = ((position / length) * 100).toFixed(1) + '%';
  }
}

function initAudioInput() {
  const srcSel = document.getElementById('audio-in-source');
  if (srcSel) srcSel.addEventListener('change', (e) => switchAudioInputMode(e.target.value));

  const devSel = document.getElementById('audio-in-device');
  if (devSel) devSel.addEventListener('change', (e) => selectAudioInputDevice(e.target.value));

  const loadBtn = document.getElementById('btn-load-sample');
  const fileInput = document.getElementById('sample-file-input');
  if (loadBtn && fileInput) {
    loadBtn.addEventListener('click', () => fileInput.click());
  }
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadSampleFile(file);
    });
  }

  const playBtn = document.getElementById('btn-sample-play');
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      state.samplePlaying = !state.samplePlaying;
      if (state.workletNode) {
        if (state.samplePlaying) {
          state.workletNode.port.postMessage({ type: 'sample-play', fromStart: false });
        } else {
          state.workletNode.port.postMessage({ type: 'sample-stop' });
        }
      }
      updateSampleTransportUI();
    });
  }

  const loopBtn = document.getElementById('btn-sample-loop');
  if (loopBtn) {
    loopBtn.addEventListener('click', () => {
      state.sampleLoop = !state.sampleLoop;
      loopBtn.classList.toggle('active', state.sampleLoop);
      if (state.workletNode) {
        state.workletNode.port.postMessage({ type: 'sample-loop', loop: state.sampleLoop });
      }
    });
  }
}

function updateSampleTransportUI() {
  const playBtn = document.getElementById('btn-sample-play');
  if (playBtn) {
    playBtn.textContent = state.samplePlaying ? 'Stop' : 'Play';
  }
}

// ─── Audio Engine ──────────────────────────────────────────────────

async function startAudio() {
  if (state.isPlaying) return;
  if (!state.wasmBytes) return;

  try {
    if (!state.audioContext) {
      state.audioContext = new AudioContext({ sampleRate: 48000 });
    }

    if (state.audioContext.state === 'suspended') {
      await state.audioContext.resume();
    }

    await state.audioContext.audioWorklet.addModule('worklet-processor.js');

    state.workletNode = new AudioWorkletNode(state.audioContext, 'daisy-processor', {
      numberOfInputs: 1,
      outputChannelCount: [2],
    });

    state.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'rms') {
        state.rmsLevel = e.data.level;
        updateVuMeter();
      } else if (e.data.type === 'ready') {
        for (let i = 0; i < 4; i++) {
          state.workletNode.port.postMessage({ type: 'set-knob', index: i, value: state.knobs[i] });
        }
      } else if (e.data.type === 'sample-position') {
        state.samplePosition = e.data.position;
        state.samplePlaying = e.data.playing;
        updateSamplePositionUI(e.data.position, e.data.length);
        if (!e.data.playing && state.samplePlaying) {
          state.samplePlaying = false;
          updateSampleTransportUI();
        }
      } else if (e.data.type === 'error') {
        console.error('Worklet error:', e.data.message);
        setStatus('error', `Audio error: ${e.data.message}`);
      }
    };

    state.workletNode.connect(state.audioContext.destination);

    state.workletNode.port.postMessage({
      type: 'load-wasm',
      wasmBytes: state.wasmBytes,
    });

    // Re-connect audio input sources to the new worklet
    connectAudioInputToWorklet();

    state.isPlaying = true;
    updateUI();
  } catch (err) {
    console.error('Audio start failed:', err);
    setStatus('error', `Audio error: ${err.message}`);
  }
}

function stopAudio() {
  if (!state.isPlaying) return;

  // Disconnect source node but keep stream alive for re-use
  if (state.audioInputSourceNode) {
    try { state.audioInputSourceNode.disconnect(); } catch (e) { /* ignore */ }
    state.audioInputSourceNode = null;
  }

  if (state.workletNode) {
    state.workletNode.port.postMessage({ type: 'stop' });
    state.workletNode.disconnect();
    state.workletNode = null;
  }

  state.isPlaying = false;
  state.rmsLevel = 0;
  updateVuMeter();
  updateUI();
}

// ─── History ───────────────────────────────────────────────────────

function addToHistory(prompt, code) {
  const entry = {
    timestamp: Date.now(),
    prompt,
    code,
    compiled: state.compiled,
    skill: state.skill,
  };

  state.history.unshift(entry);
  if (state.history.length > 50) state.history.length = 50;
  localStorage.setItem('daisy-gpt-history', JSON.stringify(state.history));
}

function restoreFromHistory(index) {
  const entry = state.history[index];
  if (!entry) return;

  state.previousCode = state.code;
  state.code = entry.code;
  extractKnobLabels(state.code);
  updateKnobLabels();
  syncCodeToEditor();

  // Show restored code in chat
  const content = `Restored patch from history:\n\n\`\`\`cpp\n${entry.code}\n\`\`\``;
  const el = appendChatBubble('assistant', content);
  if (el) finalizeAssistantBubble(el, content);

  closeHistory();
  compileCode();
}

// ─── UI Updates ────────────────────────────────────────────────────

function updateUI() {
  const sendBtn = $('#btn-send');
  const undoBtn = $('#btn-undo');
  const playBtn = $('#btn-play');
  const stopBtn = $('#btn-stop');
  const flashBtn = $('#btn-flash');
  const downloadBtn = $('#btn-download');
  const compileBtn = $('#btn-compile');
  const loadCompilerBtn = $('#btn-load-compiler');

  const stopChatBtn = $('#btn-stop-chat');
  if (sendBtn) {
    sendBtn.disabled = state.isGenerating;
    sendBtn.classList.toggle('hidden', state.isGenerating);
  }
  if (stopChatBtn) {
    stopChatBtn.classList.toggle('hidden', !state.isGenerating);
  }
  if (undoBtn) undoBtn.disabled = !state.previousCode;
  if (playBtn) {
    playBtn.classList.toggle('playing', state.isPlaying);
    playBtn.textContent = state.isPlaying ? '\u25b6 Playing' : '\u25b6 Play';
  }
  if (flashBtn) flashBtn.disabled = !state.compiled;
  if (downloadBtn) downloadBtn.disabled = !state.code;
  if (compileBtn) {
    compileBtn.disabled = !state.code || state.isCompiling;
    compileBtn.textContent = state.isCompiling ? 'Compiling...' : 'Compile C++';
  }
  if (loadCompilerBtn) {
    if (state.compiler.loaded) {
      loadCompilerBtn.textContent = 'Compiler Ready';
      loadCompilerBtn.classList.add('loaded');
      loadCompilerBtn.disabled = true;
    } else if (state.compilerLoading) {
      loadCompilerBtn.textContent = 'Loading...';
      loadCompilerBtn.disabled = true;
    } else {
      loadCompilerBtn.textContent = 'Load Compiler';
      loadCompilerBtn.disabled = false;
    }
  }
}

function updateKnobLabels() {
  for (let i = 0; i < 4; i++) {
    const label = $(`#knob-label-${i}`);
    if (label) label.textContent = state.knobLabels[i];
  }
}

function updateVuMeter() {
  const bar = $('#vu-bar');
  if (!bar) return;
  const level = Math.min(state.rmsLevel * 3, 1);
  const pct = level * 100;
  bar.style.width = `${pct}%`;
  bar.classList.toggle('hot', level > 0.6);
}

function setStatus(type, message) {
  const el = $('#status-text');
  if (!el) return;
  el.className = `status-text ${type}`;
  el.textContent = message;
}

// ─── Provider / Model ──────────────────────────────────────────────

function populateModelDropdown() {
  const select = $('#model-select');
  if (!select) return;

  const provider = PROVIDERS[state.provider];
  if (!provider) return;

  // For Ollama, fetch models dynamically if list is empty
  if (state.provider === 'ollama' && provider.models.length === 0) {
    clearSelectOptions(select);
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Loading models...';
    select.appendChild(opt);
    refreshOllamaModels();
    return;
  }

  clearSelectOptions(select);
  for (const m of provider.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }

  const hasModel = provider.models.some(m => m.id === state.model);
  if (hasModel) {
    select.value = state.model;
  } else if (provider.models.length > 0) {
    state.model = provider.models[0].id;
    select.value = state.model;
    localStorage.setItem('daisy-gpt-model', state.model);
  }
}

function clearSelectOptions(select) {
  while (select.firstChild) select.removeChild(select.firstChild);
}

async function refreshOllamaModels() {
  const provider = PROVIDERS.ollama;
  const select = $('#model-select');
  const status = $('#key-status-ollama');

  try {
    await provider.fetchModels();
    if (state.provider === 'ollama' && select) {
      clearSelectOptions(select);
      for (const m of provider.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        select.appendChild(opt);
      }
      const hasModel = provider.models.some(m => m.id === state.model);
      if (hasModel) {
        select.value = state.model;
      } else if (provider.models.length > 0) {
        state.model = provider.models[0].id;
        select.value = state.model;
        localStorage.setItem('daisy-gpt-model', state.model);
      }
    }
    if (status) {
      status.textContent = '\u2713';
      status.style.color = 'var(--accent-gold)';
    }
  } catch (e) {
    if (select && state.provider === 'ollama') {
      clearSelectOptions(select);
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models found';
      select.appendChild(opt);
    }
    if (status) {
      status.textContent = '\u2717';
      status.style.color = 'var(--accent-red)';
    }
    setStatus('error', e.message);
  }
}

// ─── Modal Handlers ────────────────────────────────────────────────

function showApiKeyModal() {
  const modal = $('#api-key-modal');
  if (modal) {
    modal.classList.remove('hidden');
    for (const [id] of Object.entries(PROVIDERS)) {
      const input = $(`#key-${id}`);
      if (input) input.value = getApiKey(id);
      const status = $(`#key-status-${id}`);
      if (status) status.textContent = getApiKey(id) ? '\u2713' : '';
    }
    // Ollama URL field
    const ollamaUrlInput = $('#ollama-url');
    if (ollamaUrlInput) ollamaUrlInput.value = getOllamaUrl();

    if (state.provider === 'ollama') {
      ollamaUrlInput?.focus();
    } else {
      $(`#key-${state.provider}`)?.focus();
    }
  }
}

function hideApiKeyModal() {
  const modal = $('#api-key-modal');
  if (modal) modal.classList.add('hidden');
}

function saveAllKeys() {
  for (const id of Object.keys(PROVIDERS)) {
    const input = $(`#key-${id}`);
    if (input) setApiKey(id, input.value.trim());
  }
  // Save Ollama URL
  const ollamaUrlInput = $('#ollama-url');
  if (ollamaUrlInput) {
    setOllamaUrl(ollamaUrlInput.value.trim() || 'http://localhost:11434');
  }
  hideApiKeyModal();
}

async function testProviderKey(providerId) {
  const status = $(`#key-status-${providerId}`);
  if (!status) return;

  // Ollama: test connectivity, no API key needed
  if (providerId === 'ollama') {
    const urlInput = $('#ollama-url');
    if (urlInput) setOllamaUrl(urlInput.value.trim() || 'http://localhost:11434');
    status.textContent = '...';
    try {
      await PROVIDERS.ollama.test();
      status.textContent = '\u2713';
      status.style.color = 'var(--accent-gold)';
    } catch (e) {
      status.textContent = '\u2717';
      status.style.color = 'var(--accent-red)';
      setStatus('error', e.message);
    }
    return;
  }

  const input = $(`#key-${providerId}`);
  if (!input) return;

  const key = input.value.trim();
  if (!key) { status.textContent = '\u2717'; return; }

  status.textContent = '...';
  try {
    await PROVIDERS[providerId].test(key);
    status.textContent = '\u2713';
    status.style.color = 'var(--accent-gold)';
  } catch (e) {
    status.textContent = '\u2717';
    status.style.color = 'var(--accent-red)';
  }
}

function showHistory() {
  const overlay = $('#history-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    renderHistoryList();
  }
}

function closeHistory() {
  const overlay = $('#history-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function renderHistoryList() {
  const list = $('#history-list');
  if (!list) return;

  if (state.history.length === 0) {
    list.innerHTML = '<div class="history-empty">No patches yet. Generate your first one!</div>';
    return;
  }

  list.innerHTML = state.history.map((entry, idx) => {
    const time = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const date = new Date(entry.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const statusClass = entry.compiled ? 'compiled' : 'pending';
    return `<div class="history-item" data-index="${idx}">
      <div class="status-dot ${statusClass}"></div>
      <span class="time">${date} ${time}</span>
      <span class="prompt">${escapeHtml(entry.prompt)}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      restoreFromHistory(parseInt(item.dataset.index));
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── DFU Flash ─────────────────────────────────────────────────────

async function flashToDaisy() {
  if (!isWebUSBSupported()) {
    alert('WebUSB is not supported in this browser. Please use Chrome or Edge.');
    return;
  }

  if (!isChromeBrowser()) {
    alert('WebUSB requires Chrome or Edge. Firefox does not support WebUSB.');
    return;
  }

  const overlay = $('#dfu-overlay');
  const progressFill = $('#dfu-progress-fill');
  const logEl = $('#dfu-log');

  if (overlay) overlay.classList.remove('hidden');
  if (logEl) logEl.textContent = '';

  const dfu = new DaisyDFU();

  dfu.onLog = (msg) => {
    if (logEl) logEl.textContent += msg + '\n';
    logEl.scrollTop = logEl.scrollHeight;
  };

  dfu.onProgress = ({ phase, current, total, percent }) => {
    if (progressFill) {
      progressFill.style.width = `${percent || Math.round((current / total) * 100)}%`;
    }
  };

  try {
    dfu.log('Waiting for DFU device...');
    dfu.log('Put Daisy in DFU mode: hold BOOT, tap RESET');

    const found = await dfu.requestDevice();
    if (!found) return;

    await dfu.open();

    dfu.log('Note: v0.1 flashes preview WASM only.');
    dfu.log('For ARM binary, use "Download .cpp" and compile with daisy-gpt CLI.');

    if (state.wasmBytes) {
      await dfu.flash(state.wasmBytes.buffer);
    }

    await dfu.close();
    dfu.log('Done!');

  } catch (err) {
    dfu.log(`Error: ${err.message}`);
  }
}

function closeDfuOverlay() {
  const overlay = $('#dfu-overlay');
  if (overlay) overlay.classList.add('hidden');
}

// ─── Downloads ─────────────────────────────────────────────────────

function downloadCpp() {
  if (!state.code) return;

  const blob = new Blob([state.code], { type: 'text/x-c++src' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'patch.cpp';
  a.click();
  URL.revokeObjectURL(url);
}

// ─── MIDI ─────────────────────────────────────────────────────────

function initMIDI() {
  const midi = new MIDIController();
  state.midi = midi;
  midi.loadCCMap();

  for (let k = 0; k < 4; k++) {
    const sel = $(`#midi-cc-${k}`);
    if (!sel) continue;
    for (let cc = 0; cc < 128; cc++) {
      const opt = document.createElement('option');
      opt.value = cc;
      opt.textContent = `CC${cc}`;
      if (cc === midi.ccKnobMap[k]) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', (e) => {
      midi.setCC(k, parseInt(e.target.value));
    });
  }

  $('#btn-midi-connect')?.addEventListener('click', async () => {
    const ok = await midi.init();
    if (ok) {
      $('#btn-midi-connect').textContent = 'Connected';
      $('#btn-midi-connect').classList.add('connected');
      state.midiConnected = true;
      const devices = midi.getDevices();
      if (devices.length > 0 && !midi.activeInput) {
        midi.selectDevice(devices[0].id);
        updateMIDIDeviceDropdown(devices);
        const sel = $('#midi-device-select');
        if (sel) sel.value = devices[0].id;
      }
    }
  });

  $('#midi-device-select')?.addEventListener('change', (e) => {
    midi.selectDevice(e.target.value);
  });

  midi.onStateChange = (ms) => {
    $('#midi-note').textContent = ms.noteName;
    $('#midi-cv').textContent = ms.pitchCV.toFixed(2);
    $('#midi-vel').textContent = Math.round(ms.velocity * 127);
    $('#midi-pb').textContent = ms.pitchBend.toFixed(2);

    const readout = $('#midi-readout');
    if (readout) readout.classList.toggle('gate-active', ms.gate);

    if (state.workletNode) {
      if (ms.gate) {
        state.workletNode.port.postMessage({
          type: 'midi-note-on',
          pitchCV: ms.pitchCV,
          velocity: ms.velocity,
        });
      } else {
        state.workletNode.port.postMessage({ type: 'midi-note-off' });
      }
      state.workletNode.port.postMessage({
        type: 'midi-pitchbend',
        value: ms.pitchBend,
      });
    }
  };

  midi.onKnobChange = (index, value) => {
    state.knobs[index] = value;
    const slider = $(`#knob-${index}`);
    if (slider) slider.value = value;
    $(`#knob-val-${index}`).textContent = value.toFixed(2);
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: 'set-knob', index, value });
    }
  };

  midi.onDevicesChange = (devices) => {
    updateMIDIDeviceDropdown(devices);
  };
}

function updateMIDIDeviceDropdown(devices) {
  const sel = $('#midi-device-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">No device</option>';
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    if (d.id === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ─── Code Panel & Tabs ────────────────────────────────────────────

function syncCodeToEditor() {
  const editor = $('#code-editor');
  if (editor) {
    editor.value = state.code;
    editor.readOnly = false;
    const statusEl = $('#code-editor-status');
    if (statusEl) statusEl.textContent = 'patch.cpp';
  }
}

function syncEditorToCode() {
  const editor = $('#code-editor');
  if (editor && !editor.readOnly) {
    state.code = editor.value;
  }
}

function switchTab(tabName) {
  state.activeTab = tabName;

  for (const btn of $$('.tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
    if (btn.dataset.tab === tabName) {
      btn.classList.remove('has-update');
    }
  }

  for (const content of $$('.tab-content')) {
    content.classList.toggle('active', content.id === `${tabName}-tab`);
  }

  if (tabName === 'code' && state.code) {
    syncCodeToEditor();
  }
}

function flashTab(tabName) {
  if (state.activeTab === tabName) return;
  const btn = $(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('has-update');
}

function showToast(message) {
  let toast = $('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// ─── File Registry ────────────────────────────────────────────────

function registerFile(path, content, type = 'system') {
  state.fileRegistry.set(path, { content, type });
}

function populateFileRegistry() {
  if (!state.compiler.loaded) return;

  const headers = state.compiler.getHeaders();
  for (const [path, content] of headers) {
    registerFile(`include/${path}`, content, 'system');
  }

  renderFileTree();
}

function renderFileTree() {
  const browser = $('#file-browser');
  if (!browser) return;

  // Build nested tree structure
  const tree = {};
  for (const [path, { type }] of state.fileRegistry) {
    const parts = path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = { _file: true, _path: path, _type: type };
  }

  browser.innerHTML = '';
  renderTreeNode(browser, tree, '');
}

function renderTreeNode(container, node, prefix) {
  const folders = [];
  const files = [];

  for (const [name, value] of Object.entries(node)) {
    if (value._file) {
      files.push({ name, path: value._path, type: value._type });
    } else {
      folders.push({ name, children: value });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (const folder of folders) {
    const folderEl = document.createElement('div');
    folderEl.className = 'file-tree-folder';

    const label = document.createElement('div');
    label.className = 'file-tree-folder-label';

    const icon = document.createElement('span');
    icon.className = 'folder-icon';
    icon.textContent = '\u25b6';
    label.appendChild(icon);
    label.appendChild(document.createTextNode(folder.name));

    label.addEventListener('click', () => {
      folderEl.classList.toggle('open');
      icon.textContent = folderEl.classList.contains('open') ? '\u25bc' : '\u25b6';
    });

    const childrenEl = document.createElement('div');
    childrenEl.className = 'file-tree-children';
    renderTreeNode(childrenEl, folder.children, prefix + folder.name + '/');

    folderEl.appendChild(label);
    folderEl.appendChild(childrenEl);
    container.appendChild(folderEl);
  }

  for (const file of files) {
    const fileEl = document.createElement('div');
    fileEl.className = 'file-tree-file';

    const fileIcon = document.createElement('span');
    fileIcon.className = 'file-icon';
    fileIcon.textContent = '\u25a1';
    fileEl.appendChild(fileIcon);
    fileEl.appendChild(document.createTextNode(file.name));

    fileEl.addEventListener('click', () => openFileViewer(file.path));
    container.appendChild(fileEl);
  }
}

function openFileViewer(path) {
  const entry = state.fileRegistry.get(path);
  if (!entry) return;

  state.viewingFile = path;

  const editor = $('#code-editor');
  const statusEl = $('#code-editor-status');
  if (editor) {
    editor.value = entry.content;
    editor.readOnly = true;
  }
  if (statusEl) statusEl.textContent = path + ' (read-only)';
  switchTab('code');
}

// Apply edit from chat inline button
window._applyEditFromChat = function(btn) {
  const search = decodeURIComponent(atob(btn.dataset.search));
  const replace = decodeURIComponent(atob(btn.dataset.replace));

  if (!state.code) {
    showToast('No code to edit');
    return;
  }

  const { code, results } = applyEdits([{ file: 'patch.cpp', search, replace }], state.code);
  if (results[0]?.ok) {
    state.previousCode = state.code;
    state.code = code;
    extractKnobLabels(state.code);
    updateKnobLabels();
    syncCodeToEditor();
    flashTab('code');
    showToast('Edit applied');
    updateUI();
    compileCode();
    btn.textContent = 'Applied!';
    btn.disabled = true;
  } else {
    showToast('Edit failed: SEARCH text not found');
    btn.textContent = 'Failed';
  }
};

function initCodePanel() {
  // Tab switching
  for (const btn of $$('.tab-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // Code editor sync and cursor position
  const editor = $('#code-editor');
  if (editor) {
    editor.addEventListener('input', () => {
      if (!editor.readOnly) {
        syncEditorToCode();
      }
    });

    // Tab key inserts tab character
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.substring(0, start) + '    ' + editor.value.substring(end);
        editor.selectionStart = editor.selectionEnd = start + 4;
        syncEditorToCode();
      }
    });

    // Update line/col display
    const updatePos = () => {
      const posEl = $('#code-editor-pos');
      if (!posEl) return;
      const val = editor.value.substring(0, editor.selectionStart);
      const lines = val.split('\n');
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      posEl.textContent = `Ln ${line}, Col ${col}`;
    };
    editor.addEventListener('click', updatePos);
    editor.addEventListener('keyup', updatePos);
  }

  // File viewer close button — return to user code
  $('#file-viewer-close')?.addEventListener('click', () => {
    state.viewingFile = null;
    if (state.code) {
      syncCodeToEditor();
    } else {
      const ed = $('#code-editor');
      if (ed) { ed.value = ''; ed.readOnly = false; }
      const st = $('#code-editor-status');
      if (st) st.textContent = 'patch.cpp';
    }
  });
}

// ─── Event Binding ─────────────────────────────────────────────────

function init() {
  // Send button
  $('#btn-send')?.addEventListener('click', () => {
    const text = $('#chat-input')?.value?.trim();
    if (!text || state.isGenerating) return;
    sendMessage(text);
  });

  // Stop button
  $('#btn-stop-chat')?.addEventListener('click', () => {
    stopGeneration();
  });

  // Enter key in chat input (Shift+Enter for newline)
  $('#chat-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text && !state.isGenerating) sendMessage(text);
    }
  });

  // Auto-resize chat textarea
  $('#chat-input')?.addEventListener('input', (e) => {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  // New chat
  $('#btn-new-chat')?.addEventListener('click', () => {
    state.messages = [];
    const container = $('#chat-messages');
    if (container) {
      container.innerHTML = `
        <div class="chat-welcome">
          <div class="chat-welcome-logo">daisy-gpt</div>
          <p>I'm your Daisy Patch programming assistant. Describe a synth patch and I'll write the code, compile it, and let you play it right here.</p>
          <p class="chat-welcome-hint">Try: "acid bassline with resonant filter and portamento"</p>
        </div>`;
    }
  });

  // Undo
  $('#btn-undo')?.addEventListener('click', () => {
    if (state.previousCode) {
      state.code = state.previousCode;
      state.previousCode = '';
      syncCodeToEditor();
      updateUI();
      compileCode();
    }
  });

  // Play/Stop
  $('#btn-play')?.addEventListener('click', () => {
    if (state.isPlaying) {
      stopAudio();
    } else {
      startAudio();
    }
  });

  $('#btn-stop')?.addEventListener('click', stopAudio);

  // Flash
  $('#btn-flash')?.addEventListener('click', flashToDaisy);

  // Download
  $('#btn-download')?.addEventListener('click', downloadCpp);

  // API keys
  $('#btn-api-key')?.addEventListener('click', showApiKeyModal);
  $('#btn-save-api-key')?.addEventListener('click', saveAllKeys);
  $('#btn-cancel-api-key')?.addEventListener('click', hideApiKeyModal);

  // Test buttons
  for (const btn of $$('.btn-test')) {
    if (btn.id === 'btn-refresh-ollama') continue; // handled separately
    btn.addEventListener('click', () => testProviderKey(btn.dataset.provider));
  }

  // Ollama refresh models button
  $('#btn-refresh-ollama')?.addEventListener('click', async () => {
    const urlInput = $('#ollama-url');
    if (urlInput) setOllamaUrl(urlInput.value.trim() || 'http://localhost:11434');
    PROVIDERS.ollama.models = [];
    await refreshOllamaModels();
  });

  // History
  $('#btn-history')?.addEventListener('click', showHistory);
  $('#btn-close-history')?.addEventListener('click', closeHistory);

  // DFU
  $('#btn-close-dfu')?.addEventListener('click', closeDfuOverlay);

  // Close modals on backdrop click
  $('#api-key-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'api-key-modal') hideApiKeyModal();
  });
  $('#history-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'history-overlay') closeHistory();
  });

  // Provider selector
  $('#provider-select')?.addEventListener('change', (e) => {
    state.provider = e.target.value;
    localStorage.setItem('daisy-gpt-provider', state.provider);
    populateModelDropdown();
    updateThinkingControls();
  });

  // Model selector
  $('#model-select')?.addEventListener('change', (e) => {
    state.model = e.target.value;
    localStorage.setItem('daisy-gpt-model', state.model);
    updateThinkingControls();
  });

  // Thinking toggle
  $('#thinking-toggle')?.addEventListener('change', (e) => {
    state.thinkingEnabled = e.target.checked;
    localStorage.setItem('daisy-gpt-thinking', state.thinkingEnabled);
    updateThinkingControls();
  });

  // Thinking budget slider (Anthropic)
  $('#thinking-budget')?.addEventListener('input', (e) => {
    state.thinkingBudget = parseInt(e.target.value);
    localStorage.setItem('daisy-gpt-thinking-budget', state.thinkingBudget);
    const label = $('#budget-value');
    if (label) label.textContent = formatBudget(state.thinkingBudget);
  });

  // Reasoning effort dropdown (OpenAI)
  $('#reasoning-effort')?.addEventListener('change', (e) => {
    state.reasoningEffort = e.target.value;
    localStorage.setItem('daisy-gpt-reasoning-effort', state.reasoningEffort);
  });

  // Skill selector
  $('#skill-select')?.addEventListener('change', (e) => {
    state.skill = e.target.value;
    localStorage.setItem('daisy-gpt-skill', state.skill);
  });

  // Knob sliders
  for (let i = 0; i < 4; i++) {
    const slider = $(`#knob-${i}`);
    if (slider) {
      slider.value = state.knobs[i];
      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        state.knobs[i] = val;
        $(`#knob-val-${i}`).textContent = val.toFixed(2);
        if (state.workletNode) {
          state.workletNode.port.postMessage({ type: 'set-knob', index: i, value: val });
        }
      });
    }
  }

  // Gate buttons
  for (let i = 0; i < 2; i++) {
    const btn = $(`#gate-${i}`);
    if (btn) {
      const triggerGate = () => {
        btn.classList.add('active');
        if (state.workletNode) {
          state.workletNode.port.postMessage({ type: 'set-gate', index: i, value: true });
        }
        setTimeout(() => {
          btn.classList.remove('active');
          if (state.workletNode) {
            state.workletNode.port.postMessage({ type: 'set-gate', index: i, value: false });
          }
        }, 80);
      };
      btn.addEventListener('mousedown', triggerGate);
      btn.addEventListener('touchstart', (e) => { e.preventDefault(); triggerGate(); });
    }
  }

  // Populate skill dropdown
  const skillSelect = $('#skill-select');
  if (skillSelect) {
    skillSelect.innerHTML = '<option value="">No skill</option>';
    for (const name of skillNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name.replace(/_/g, ' ');
      if (name === state.skill) opt.selected = true;
      skillSelect.appendChild(opt);
    }
  }

  // Compile button (loads compiler on first click if not loaded)
  $('#btn-compile')?.addEventListener('click', async () => {
    if (!state.code) return;
    if (!state.compiler.loaded) {
      await loadCompiler();
    }
    state.compileRetries = 0;
    await compileCode();
  });

  // Load compiler button
  $('#btn-load-compiler')?.addEventListener('click', () => {
    loadCompiler();
  });

  // Code panel & tabs
  initCodePanel();

  // Audio Input Setup
  initAudioInput();

  // MIDI Setup
  initMIDI();

  // Migrate old single API key
  migrateOldKey();

  // Set provider dropdown
  const providerSelect = $('#provider-select');
  if (providerSelect) providerSelect.value = state.provider;

  // Populate model dropdown and thinking controls
  populateModelDropdown();
  updateThinkingControls();

  // Show API key modal if no key
  if (!currentApiKey()) {
    setTimeout(showApiKeyModal, 500);
  }

  // Initial UI state
  updateUI();
  setStatus('', 'Ready');
}

// ─── Boot ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
