// daisy-gpt browser edition — AI-powered Daisy development platform
// No framework, no build step. Pure vanilla JS.

import { skills, skillNames } from './skills/index.js';
import { DAISYSP_REFERENCE } from './reference/daisysp_ref.js';
import { DaisyDFU, isWebUSBSupported, isChromeBrowser } from './dfu.js';
import { PROVIDERS, getApiKey, setApiKey, migrateOldKey, initKeyStore, getOllamaUrl, setOllamaUrl } from './providers.js';
import { MIDIController } from './midi.js';
import { WasmClangCompiler } from './compiler.js';
import { BOARDS, BOARD_IDS, DEFAULT_BOARD, getBoardPromptFragment, getBoardKnobCount, getBoardIOSummary } from './boards.js';
import { createProject, addFile, deleteFile, renameFile, updateFileContent, getActiveFileContent, getFilePaths, getCppFiles, getAllFiles, getProjectSummary, getProjectContext, saveProject, saveProjectAs, loadProject, loadProjectByName, deleteProjectByName, duplicateProject, renameProject, loadProjectsList, migrateFromLegacy } from './project-manager.js';
import { AudioAnalyzer, analyzeAudioBuffer } from './audio-analyzer.js';
import { profileCode, getProfileContext, getCycleReferenceTable } from './profiler.js';
import { PatchEvolver } from './patch-evolver.js';
import { exportProjectZip, importProjectZip, exportProjectURL, importProjectURL, downloadFile, createGist, loadFromGist, getGitHubToken, setGitHubToken } from './project-io.js';

// ─── State ─────────────────────────────────────────────────────────

const state = {
  provider: localStorage.getItem('daisy-gpt-provider') || 'anthropic',
  model: localStorage.getItem('daisy-gpt-model') || 'claude-opus-4-6',
  skill: localStorage.getItem('daisy-gpt-skill') || '',
  // Project state (replaces single-file state.code)
  project: null, // Initialized in init()
  code: '', // Convenience accessor — always mirrors active file content
  previousCode: '',
  isGenerating: false,
  isCompiling: false,
  isPlaying: false,
  compiled: false,
  wasmBytes: null,
  audioContext: null,
  workletNode: null,
  knobs: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
  knobLabels: ['Knob 1', 'Knob 2', 'Knob 3', 'Knob 4', 'Knob 5', 'Knob 6', 'Knob 7', 'Knob 8'],
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
  // Diagnostics
  analyserNode: null,
  diagAnimFrame: null,
  peakLevel: 0,
  peakHoldTime: 0,
  clipDetected: false,
  clipTime: 0,
  // Remote ARM compilation
  remoteCompileUrl: localStorage.getItem('daisy-gpt-compile-url') || 'https://compile.brokmodular.com',
  isRemoteCompiling: false,
  armBinaryBytes: null,
  armTargetAddress: null,
  // Agent tools
  audioAnalyzer: new AudioAnalyzer(),
  evolver: new PatchEvolver(),
  lastProfile: null,
};

// ─── DOM References ────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── System Prompt ─────────────────────────────────────────────────

// Dynamic system prompt — built per-message based on board, project, and tool state
function buildSystemPrompt() {
  const board = state.project ? state.project.board : DEFAULT_BOARD;
  const boardPrompt = getBoardPromptFragment(board);

  let prompt = `You are daisy-gpt, an expert AI pair programmer for the Electro-Smith Daisy embedded audio platform using DaisySP.

You work alongside the user as a knowledgeable collaborator, helping them build, debug, and understand DSP projects. You can:
- Generate complete C++ code for any Daisy board (Seed, Patch, Patch SM, Pod, Petal, Field)
- Work with multi-file projects (multiple .cpp/.h files)
- Explain code, debug errors, suggest improvements
- Answer questions about DaisySP, synthesis, DSP theory, and embedded audio
- Analyze audio output to give feedback on how the patch sounds
- Profile patches to estimate CPU/memory usage on hardware

BOARD CONTEXT:
${boardPrompt}

IMPORTANT CODE CONSTRAINTS:
- Always include COMPLETE, COMPILABLE code in your \`\`\`cpp blocks — never partial snippets
- All DSP objects must be static globals (not on stack)
- Large DelayLines (>24000 samples) must use DSY_SDRAM_BSS
- Never allocate memory in AudioCallback
- Always call Process() every sample for envelopes/oscillators
- Use fclamp() to prevent out-of-range filter frequencies
- Keep output levels reasonable — use SoftClip() if mixing multiple sources

MULTI-FILE PROJECTS:
When providing code for a specific file, include the filename as a comment at the top:
\`\`\`cpp
// --- main.cpp
#include "daisy_patch.h"
...
\`\`\`

To create a new file, use a \`\`\`newfile block:
\`\`\`newfile
--- dsp/filter.h
#pragma once
...
\`\`\`

To delete a file, use a \`\`\`deletefile block:
\`\`\`deletefile
--- old_module.h
\`\`\`

EDIT COMMANDS:
When the user asks for a small change, prefer edit commands over full regeneration.
Edit format — wrap each edit in a fenced \`\`\`edit block:
\`\`\`edit
--- main.cpp
<<<<<<< SEARCH
exact lines to find in current code
=======
replacement lines
>>>>>>> REPLACE
\`\`\`

Rules:
- Specify which file to edit after ---
- SEARCH text must match the current code exactly (including indentation)
- Include 1-2 context lines around the change for unique matching
- Multiple edit blocks per response are fine, applied in order

${getCycleReferenceTable()}

Be concise but helpful. Focus on being a great collaborator.

DaisySP REFERENCE:
${DAISYSP_REFERENCE}`;

  return prompt;
}

// Legacy compatibility — keep the const name for any code that references it
const SYSTEM_PROMPT = null; // Now dynamically generated via buildSystemPrompt()

// ─── Chat / LLM ───────────────────────────────────────────────────

async function currentApiKey() {
  if (state.provider === 'ollama') return 'ollama';
  return await getApiKey(state.provider);
}

async function sendMessage(userText) {
  if (!(await currentApiKey())) {
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
  let systemPrompt = buildSystemPrompt();
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
  // Inject project context (all files)
  if (state.project && Object.keys(state.project.files).length > 0) {
    systemPrompt += `\n\n${getProjectSummary(state.project)}`;
    systemPrompt += `\nPROJECT FILES:\n${getProjectContext(state.project)}`;
    const totalLines = Object.values(state.project.files).reduce((sum, f) => sum + f.content.split('\n').length, 0);
    if (totalLines > 20) {
      systemPrompt += 'The user has existing code. Prefer edit commands for small changes.';
    }
  }
  // Inject audio analysis if audio is playing
  if (state.isPlaying && state.audioAnalyzer.ready) {
    systemPrompt += `\n\n${state.audioAnalyzer.toContextString()}`;
  }
  // Inject performance profile
  if (state.lastProfile) {
    systemPrompt += `\n\n${state.lastProfile.summary}`;
    if (state.lastProfile.warnings.length > 0) {
      systemPrompt += '\nWARNINGS: ' + state.lastProfile.warnings.join('; ');
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
    await provider.call(await currentApiKey(), state.model, systemPrompt, state.messages, (token) => {
      state.streamingContent += token;
      renderStreamingBubble(state.streamingMessageEl, state.streamingContent);
    }, state.abortController?.signal, callOptions);

    // Stream complete
    const fullResponse = state.streamingContent;
    state.messages.push({ role: 'assistant', content: fullResponse });
    finalizeAssistantBubble(state.streamingMessageEl, fullResponse);

    // Handle new response block types
    const newFiles = extractNewFilesFromResponse(fullResponse);
    const deleteFiles = extractDeleteFilesFromResponse(fullResponse);
    const variants = PatchEvolver.parseVariantsBlock(fullResponse);

    // Apply new file creations
    for (const { path, content } of newFiles) {
      try {
        addFile(state.project, path, content);
        showToast(`Created ${path}`);
      } catch { /* file exists, update instead */
        updateFileContent(state.project, path, content);
        showToast(`Updated ${path}`);
      }
    }

    // Apply file deletions
    for (const path of deleteFiles) {
      try {
        deleteFile(state.project, path);
        showToast(`Deleted ${path}`);
      } catch { /* ignore */ }
    }

    // Handle variants (evolution mode)
    if (variants && state.evolver.active) {
      state.evolver.setVariants(variants);
      state.isGenerating = false;
      state.abortController = null;
      updateUI();
      renderEvolverPanel();
      // Don't compile — user picks a variant first
    }

    // Check for edits first, then full code blocks
    else {
      const edits = extractEditsFromResponse(fullResponse);
      const extractedCode = extractCodeFromResponse(fullResponse);

      if (edits.length > 0 && state.code) {
        // Apply edit commands — now multi-file aware
        const { results } = applyProjectEdits(edits);
        const allOk = results.every(r => r.ok);
        const partial = results.some(r => r.ok);

        if (allOk || partial) {
          syncProjectToState();
          extractKnobLabels(state.code);
          updateKnobLabels();
          syncCodeToEditor();
          flashTab('code');
          const failCount = results.filter(r => !r.ok).length;
          if (allOk) {
            showToast(`${results.length} edit(s) applied`);
          } else {
            appendChatBubble('assistant', `${failCount} of ${results.length} edit(s) failed. Partial edits applied.`);
          }
          addToHistory(userText, state.code);
          saveProject(state.project);

          state.isGenerating = false;
          state.abortController = null;
          updateUI();
          await compileCode();
        } else {
          appendChatBubble('assistant', `${results.length} edit(s) failed to match. No changes applied.`);
          state.isGenerating = false;
          state.abortController = null;
          updateUI();
        }
      } else if (extractedCode) {
        // Determine target file from code comment: // --- filename.cpp
        const targetFile = extractTargetFile(extractedCode) || state.project.activeFile;
        state.previousCode = state.code;
        updateFileContent(state.project, targetFile, extractedCode);
        syncProjectToState();
        extractKnobLabels(state.code);
        updateKnobLabels();
        syncCodeToEditor();
        flashTab('code');
        addToHistory(userText, state.code);
        saveProject(state.project);

        state.isGenerating = false;
        state.abortController = null;
        updateUI();
        await compileCode();
      } else if (newFiles.length > 0 || deleteFiles.length > 0) {
        // Files were created/deleted but no code block — save and rebuild
        syncProjectToState();
        syncCodeToEditor();
        renderProjectFileTree();
        saveProject(state.project);
        state.isGenerating = false;
        state.abortController = null;
        updateUI();
        if (newFiles.some(f => f.path.endsWith('.cpp'))) await compileCode();
      } else {
        state.isGenerating = false;
        state.abortController = null;
        updateUI();
      }
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
    delete block.dataset.highlighted;
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

    actions.appendChild(copyBtn);
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

// ─── New Response Block Parsers ────────────────────────────────────

function extractNewFilesFromResponse(text) {
  const files = [];
  const regex = /```newfile\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const block = match[1];
    const fileMatch = block.match(/^---\s*(\S+)\s*$/m);
    if (fileMatch) {
      const path = fileMatch[1];
      const content = block.substring(block.indexOf('\n', block.indexOf(fileMatch[0])) + 1).trim();
      files.push({ path, content });
    }
  }
  return files;
}

function extractDeleteFilesFromResponse(text) {
  const files = [];
  const regex = /```deletefile\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const fileMatch = match[1].match(/^---\s*(\S+)\s*$/m);
    if (fileMatch) files.push(fileMatch[1]);
  }
  return files;
}

function extractTargetFile(code) {
  // Look for // --- filename.cpp at the top of the code
  const match = code.match(/^\/\/\s*---\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

/**
 * Apply edits to multi-file project. Each edit specifies its target file.
 */
function applyProjectEdits(edits) {
  const results = [];
  for (const edit of edits) {
    const filePath = edit.file || state.project.activeFile;
    const file = state.project.files[filePath];
    if (!file) {
      results.push({ ok: false, edit, reason: `File "${filePath}" not found` });
      continue;
    }

    const { code, results: editResults } = applyEdits([edit], file.content);
    if (editResults[0]?.ok) {
      state.previousCode = file.content;
      updateFileContent(state.project, filePath, code);
      results.push({ ok: true, edit });
    } else {
      results.push({ ok: false, edit, reason: 'SEARCH text not found' });
    }
  }
  return { results };
}

/**
 * Sync project state to the convenience state.code accessor.
 */
function syncProjectToState() {
  if (state.project) {
    state.code = getActiveFileContent(state.project);
  }
}

/**
 * Render the evolver panel (placeholder — will be expanded in UI phase).
 */
function renderEvolverPanel() {
  // TODO: Render evolution variant slots in UI
  if (state.evolver.active && state.evolver.variants.length > 0) {
    const labels = state.evolver.variants.map(v => v.label).join('\n');
    showToast(`Evolution Gen ${state.evolver.generation}: ${state.evolver.variants.length} variants ready`);
  }
}

/**
 * Render the project file tree in the Files tab.
 */
function renderProjectFileTree() {
  const browser = $('#file-browser');
  if (!browser || !state.project) return;

  const filePaths = getFilePaths(state.project);
  if (filePaths.length === 0) return;

  // Build tree structure from project files
  const tree = {};
  for (const path of filePaths) {
    const parts = path.split('/');
    let node = tree;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]]) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = { _file: true, _path: path, _type: 'user' };
  }

  // Also include system headers if compiler is loaded
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

function extractKnobLabels(code) {
  const knobCount = getBoardKnobCount(state.project?.board || DEFAULT_BOARD);
  const labels = [];
  for (let i = 0; i < knobCount; i++) labels.push(`Knob ${i + 1}`);

  // Parse line-by-line to avoid cross-line regex mis-matches
  for (const line of code.split('\n')) {
    // Match DaisyPatch CTRL_1..CTRL_8
    const ctrlMatch = line.match(/CTRL_(\d).*\/\/\s*(.+)/);
    if (ctrlMatch) {
      const idx = parseInt(ctrlMatch[1]) - 1;
      if (idx >= 0 && idx < knobCount) {
        labels[idx] = ctrlMatch[2].trim().substring(0, 20);
      }
    }
    // Match Patch SM CV_1..CV_8
    const cvMatch = line.match(/CV_(\d)(?:\b|[^_]).*\/\/\s*(.+)/);
    if (cvMatch) {
      const idx = parseInt(cvMatch[1]) - 1;
      if (idx >= 0 && idx < knobCount) {
        labels[idx] = cvMatch[2].trim().substring(0, 20);
      }
    }
    // Match knob[N].Value() or knob[N] patterns (Pod, Petal, Field)
    const knobArrMatch = line.match(/knob\[(\d)\].*\/\/\s*(.+)/);
    if (knobArrMatch) {
      const idx = parseInt(knobArrMatch[1]);
      if (idx >= 0 && idx < knobCount) {
        labels[idx] = knobArrMatch[2].trim().substring(0, 20);
      }
    }
    // Match pod.knob1 / pod.knob2 style
    const knobPropMatch = line.match(/knob(\d)\..*\/\/\s*(.+)/);
    if (knobPropMatch) {
      const idx = parseInt(knobPropMatch[1]) - 1;
      if (idx >= 0 && idx < knobCount) {
        labels[idx] = knobPropMatch[2].trim().substring(0, 20);
      }
    }
  }

  state.knobLabels = labels;
}

// ─── Compiler ──────────────────────────────────────────────────────

async function compileCode() {
  if (!state.code && (!state.project || Object.keys(state.project.files).length === 0)) return;

  // Auto-load compiler if not loaded yet
  if (!state.compiler.loaded && !state.compilerLoading) {
    await loadCompiler();
  }

  state.isCompiling = true;
  state.compiled = false;
  state.compiledWithClang = false;
  setStatus('compiling', 'Compiling...');
  updateUI();

  const startTime = performance.now();

  const attemptingClang = state.compiler.loaded;

  // Get the code to compile — use active file for WASM preview
  const codeToCompile = state.code || getActiveFileContent(state.project);

  try {
    // Try C++ compilation if compiler is loaded
    if (attemptingClang) {
      state.wasmBytes = await compileWithWasmClang(codeToCompile);
      state.compiledWithClang = true;
    } else {
      // Fallback: preview synth WASM
      state.wasmBytes = generatePreviewWasm(codeToCompile);
    }

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    const mode = state.compiledWithClang ? 'Compiled C++' : 'Preview synth';
    state.compiled = true;
    state.isCompiling = false;
    setStatus('success', `${mode} (${elapsed}s)`);

    // Run profiler on successful compile
    try {
      const allCode = state.project ? getAllFiles(state.project) : codeToCompile;
      state.lastProfile = profileCode(allCode);
      updateProfilerDisplay();
    } catch { /* profiler is best-effort */ }

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
        state.wasmBytes = generatePreviewWasm(codeToCompile);
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

/**
 * Update the profiler display in the status bar.
 */
function updateProfilerDisplay() {
  const profilerEl = $('#profiler-status');
  if (!profilerEl || !state.lastProfile) return;
  profilerEl.textContent = state.lastProfile.summary;
  profilerEl.title = state.lastProfile.warnings.join('\n') || 'No warnings';
  if (state.lastProfile.cpu.percent > 80) {
    profilerEl.classList.add('warning');
  } else {
    profilerEl.classList.remove('warning');
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
  } catch (err) {
    console.error('Compiler load failed:', err);
    setStatus('error', `Compiler load failed: ${err.message}`);
  } finally {
    state.compilerLoading = false;
    updateUI();
  }
}

// ─── Remote ARM Compilation ───────────────────────────────────────

async function compileForDaisy() {
  if (!state.code && (!state.project || Object.keys(state.project.files).length === 0)) {
    setStatus('error', 'No code to compile');
    return;
  }
  if (!state.remoteCompileUrl) {
    setStatus('error', 'No compile server configured. Set it in API Keys settings.');
    return;
  }

  state.isRemoteCompiling = true;
  state.armBinaryBytes = null;
  state.armTargetAddress = null;
  updateUI();
  setStatus('compiling', 'Compiling for Daisy hardware...');

  try {
    const url = state.remoteCompileUrl.replace(/\/+$/, '') + '/compile';

    // Build request body — support both single-file (legacy) and multi-file
    const body = {};
    if (state.project && Object.keys(state.project.files).length > 1) {
      body.files = getAllFiles(state.project);
    } else {
      body.code = state.code || getActiveFileContent(state.project);
    }
    body.board = state.project?.board || DEFAULT_BOARD;
    body.target = 'qspi';

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const buffer = await response.arrayBuffer();
      state.armBinaryBytes = new Uint8Array(buffer);
      state.armTargetAddress = response.headers.get('X-Target-Address') || '0x90040000';
      const compileTime = response.headers.get('X-Compile-Time') || '?';
      const binarySize = response.headers.get('X-Binary-Size') || state.armBinaryBytes.length;
      setStatus('success', `ARM binary ready (${binarySize} bytes, ${compileTime}s) — click Flash to Daisy`);
    } else {
      const data = await response.json().catch(() => ({}));
      if (response.status === 429) {
        setStatus('error', 'Rate limited — try again in a moment');
      } else if (data.stderr) {
        setStatus('error', `ARM compile failed:\n${data.stderr}`);
      } else {
        setStatus('error', data.message || `ARM compile failed (${response.status})`);
      }
    }
  } catch (err) {
    setStatus('error', `ARM compile error: ${err.message}`);
  } finally {
    state.isRemoteCompiling = false;
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
  if (!(await currentApiKey())) return;
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

// ─── Signal Generator ─────────────────────────────────────────────

function sendSigGenConfig() {
  if (!state.workletNode) return;
  const enableEl = $('#siggen-enable');
  const targetEl = $('#siggen-target');
  const modeEl = $('#siggen-mode');
  const waveEl = $('#siggen-waveform');
  const freqEl = $('#siggen-freq');
  const gateFreqEl = $('#siggen-gate-freq');

  const config = {
    enabled: enableEl?.checked || false,
    target: parseInt(targetEl?.value || '0'),
    mode: modeEl?.value || 'wave',
    waveform: waveEl?.value || 'sin',
    freq: Math.pow(10, parseFloat(freqEl?.value || '0')),
    gateFreq: Math.pow(10, parseFloat(gateFreqEl?.value || '0.3')),
  };

  state.workletNode.port.postMessage({ type: 'set-siggen', config });
}

function initSignalGenerator() {
  const enableEl = $('#siggen-enable');
  const controlsEl = $('#siggen-controls');
  const modeEl = $('#siggen-mode');
  const freqEl = $('#siggen-freq');
  const freqValEl = $('#siggen-freq-val');
  const gateFreqEl = $('#siggen-gate-freq');
  const gateFreqValEl = $('#siggen-gate-freq-val');
  const waveRowEl = $('#siggen-wave-row');
  const gateRowEl = $('#siggen-gate-row');

  if (!enableEl) return;

  enableEl.addEventListener('change', () => {
    if (controlsEl) controlsEl.classList.toggle('hidden', !enableEl.checked);
    sendSigGenConfig();
  });

  $('#siggen-target')?.addEventListener('change', () => sendSigGenConfig());
  modeEl?.addEventListener('change', () => {
    const mode = modeEl.value;
    if (waveRowEl) waveRowEl.classList.toggle('hidden', mode !== 'wave');
    if (gateRowEl) gateRowEl.classList.toggle('hidden', mode !== 'gate');
    sendSigGenConfig();
  });
  $('#siggen-waveform')?.addEventListener('change', () => sendSigGenConfig());

  if (freqEl) {
    freqEl.addEventListener('input', () => {
      const hz = Math.pow(10, parseFloat(freqEl.value));
      if (freqValEl) freqValEl.textContent = hz < 10 ? hz.toFixed(2) + ' Hz' : hz.toFixed(1) + ' Hz';
      sendSigGenConfig();
    });
  }

  if (gateFreqEl) {
    gateFreqEl.addEventListener('input', () => {
      const hz = Math.pow(10, parseFloat(gateFreqEl.value));
      if (gateFreqValEl) gateFreqValEl.textContent = hz < 10 ? hz.toFixed(2) + ' Hz' : hz.toFixed(1) + ' Hz';
      sendSigGenConfig();
    });
  }
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

    // Also refresh output devices now that we have permission for labels
    enumerateAudioOutputDevices();
  } catch (err) {
    console.warn('Could not enumerate audio devices:', err);
    setStatus('error', 'Mic access denied: ' + err.message);
  }
}

async function selectAudioInputDevice(deviceId) {
  disconnectAudioInput();
  if (!deviceId) return;

  try {
    const constraints = { audio: deviceId === 'default' ? true : { deviceId: { exact: deviceId } } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.audioInputStream = stream;
    setStatus('success', 'Audio input: ' + (stream.getAudioTracks()[0]?.label || 'connected'));

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

// ─── Audio Output ─────────────────────────────────────────────────

async function enumerateAudioOutputDevices() {
  try {
    // Need mic permission first to get labeled devices
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

    const sel = document.getElementById('audio-out-device');
    if (!sel) return;
    while (sel.options.length > 0) sel.remove(0);
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = 'System Default';
    sel.appendChild(defaultOpt);
    for (const dev of audioOutputs) {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || ('Output ' + sel.options.length);
      sel.appendChild(opt);
    }
  } catch (err) {
    console.warn('Could not enumerate output devices:', err);
  }
}

async function selectAudioOutputDevice(deviceId) {
  if (!state.audioContext) return;
  try {
    if (state.audioContext.setSinkId) {
      await state.audioContext.setSinkId(deviceId || '');
      const label = deviceId
        ? (document.getElementById('audio-out-device')?.selectedOptions[0]?.textContent || 'selected')
        : 'System Default';
      setStatus('success', 'Audio out: ' + label);
    } else {
      setStatus('error', 'Browser does not support output device selection');
    }
  } catch (err) {
    console.error('Failed to set audio output:', err);
    setStatus('error', 'Output error: ' + err.message);
  }
}

function initAudioOutput() {
  const sel = document.getElementById('audio-out-device');
  if (sel) {
    sel.addEventListener('change', (e) => selectAudioOutputDevice(e.target.value));
  }
  // Populate on first click (devices may not have labels until mic permission granted)
  sel?.addEventListener('focus', () => enumerateAudioOutputDevices(), { once: true });
  // Also populate when audio input devices are enumerated (permission already granted)
  enumerateAudioOutputDevices();
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

    state.analyserNode = state.audioContext.createAnalyser();
    state.analyserNode.fftSize = 2048;
    state.analyserNode.smoothingTimeConstant = 0.8;
    state.workletNode.connect(state.analyserNode);
    state.analyserNode.connect(state.audioContext.destination);

    // Connect audio analyzer agent tool
    state.audioAnalyzer.connect(state.analyserNode, state.audioContext.sampleRate);

    state.workletNode.port.postMessage({
      type: 'load-wasm',
      wasmBytes: state.wasmBytes,
    });

    // Re-connect audio input sources to the new worklet
    connectAudioInputToWorklet();

    // Re-send signal generator config to new worklet
    sendSigGenConfig();

    state.isPlaying = true;
    startDiagLoop();
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

  if (state.analyserNode) {
    state.analyserNode.disconnect();
    state.analyserNode = null;
  }

  stopDiagLoop();

  state.isPlaying = false;
  state.rmsLevel = 0;
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
  const armCompileBtn = $('#btn-arm-compile');

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
  if (flashBtn) flashBtn.disabled = !state.armBinaryBytes;
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
  if (armCompileBtn) {
    armCompileBtn.disabled = !state.code || !state.remoteCompileUrl || state.isRemoteCompiling;
    armCompileBtn.textContent = state.isRemoteCompiling ? 'Compiling...' : 'Compile for Daisy';
  }
}

function updateKnobLabels() {
  for (let i = 0; i < 8; i++) {
    const label = $(`#knob-label-${i}`);
    if (label) label.textContent = state.knobLabels[i];
  }
}

// ─── Diagnostics ──────────────────────────────────────────────────

const DIAG_VIEWS = ['scope', 'spectrum', 'both'];
let diagViewIndex = 0;

const diagTimeBuf = new Float32Array(2048);
const diagFreqBuf = new Float32Array(1024);

function initDiagnostics() {
  const toggleBtn = $('#btn-diag-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      diagViewIndex = (diagViewIndex + 1) % DIAG_VIEWS.length;
      const mode = DIAG_VIEWS[diagViewIndex];
      toggleBtn.textContent = mode === 'scope' ? 'Scope' : mode === 'spectrum' ? 'FFT' : 'Both';
      $('#diag-scope')?.classList.toggle('hidden', mode === 'spectrum');
      $('#diag-spectrum')?.classList.toggle('hidden', mode === 'scope');
    });
  }
}

function startDiagLoop() {
  if (state.diagAnimFrame) return;
  function diagFrame() {
    if (!state.isPlaying || !state.analyserNode) {
      clearDiagDisplay();
      state.diagAnimFrame = null;
      return;
    }
    renderDiagnostics();
    state.diagAnimFrame = requestAnimationFrame(diagFrame);
  }
  state.diagAnimFrame = requestAnimationFrame(diagFrame);
}

function stopDiagLoop() {
  if (state.diagAnimFrame) {
    cancelAnimationFrame(state.diagAnimFrame);
    state.diagAnimFrame = null;
  }
  clearDiagDisplay();
}

function renderDiagnostics() {
  const mode = DIAG_VIEWS[diagViewIndex];
  if (mode === 'scope' || mode === 'both') renderScope();
  if (mode === 'spectrum' || mode === 'both') renderSpectrum();
  renderMeters();
}

function renderScope() {
  const canvas = $('#scope-canvas');
  if (!canvas || !state.analyserNode) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  state.analyserNode.getFloatTimeDomainData(diagTimeBuf);

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  // Center line
  ctx.strokeStyle = '#262626';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Find rising zero-crossing for trigger stability
  let triggerIndex = 0;
  for (let i = 1; i < diagTimeBuf.length - w; i++) {
    if (diagTimeBuf[i - 1] <= 0 && diagTimeBuf[i] > 0) {
      triggerIndex = i;
      break;
    }
  }

  // Waveform
  ctx.strokeStyle = '#d4a843';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const sliceLen = Math.min(w, diagTimeBuf.length - triggerIndex);
  for (let i = 0; i < sliceLen; i++) {
    const sample = diagTimeBuf[triggerIndex + i];
    const x = (i / sliceLen) * w;
    const y = (1 - sample) * h / 2;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function renderSpectrum() {
  const canvas = $('#spectrum-canvas');
  if (!canvas || !state.analyserNode) return;

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  state.analyserNode.getFloatFrequencyData(diagFreqBuf);

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  const nyquist = 48000 / 2;
  const logMin = Math.log10(20);
  const logMax = Math.log10(nyquist);

  for (let i = 0; i < w; i++) {
    const logFreq = logMin + (i / w) * (logMax - logMin);
    const freq = Math.pow(10, logFreq);
    const binIndex = Math.round(freq / nyquist * diagFreqBuf.length);
    if (binIndex >= diagFreqBuf.length) continue;

    const dbValue = diagFreqBuf[binIndex];
    const normalized = Math.max(0, (dbValue + 100) / 100);
    const barHeight = normalized * h;

    const brightness = Math.floor(normalized * 180 + 40);
    ctx.fillStyle = `rgb(${brightness}, ${Math.floor(brightness * 0.65)}, ${Math.floor(brightness * 0.25)})`;
    ctx.fillRect(i, h - barHeight, 1, barHeight);
  }
}

function renderMeters() {
  if (!state.analyserNode) return;

  state.analyserNode.getFloatTimeDomainData(diagTimeBuf);

  let sumSq = 0, peak = 0, clipped = false;
  for (let i = 0; i < diagTimeBuf.length; i++) {
    const s = diagTimeBuf[i];
    const abs = Math.abs(s);
    sumSq += s * s;
    if (abs > peak) peak = abs;
    if (abs >= 1.0) clipped = true;
  }

  const rms = Math.sqrt(sumSq / diagTimeBuf.length);
  const rmsDb = rms > 0 ? (20 * Math.log10(rms)) : -Infinity;
  const peakDb = peak > 0 ? (20 * Math.log10(peak)) : -Infinity;

  // Scale: -60 dBFS = 0%, 0 dBFS = 100%
  const rmsPct = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100));
  const peakPct = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));

  const barL = $('#meter-bar-l');
  const barR = $('#meter-bar-r');
  const peakIndL = $('#meter-peak-l');
  const peakIndR = $('#meter-peak-r');

  if (barL) { barL.style.width = rmsPct + '%'; barL.classList.toggle('hot', rmsPct > 80); }
  if (barR) { barR.style.width = rmsPct + '%'; barR.classList.toggle('hot', rmsPct > 80); }
  if (peakIndL) peakIndL.style.left = peakPct + '%';
  if (peakIndR) peakIndR.style.left = peakPct + '%';

  // Peak hold with decay
  const now = performance.now();
  if (peak > state.peakLevel) {
    state.peakLevel = peak;
    state.peakHoldTime = now;
  } else if (now - state.peakHoldTime > 1500) {
    state.peakLevel *= 0.95;
  }

  // Clip indicator (stays lit for 2s)
  if (clipped) {
    state.clipDetected = true;
    state.clipTime = now;
  }
  const clipActive = state.clipDetected && (now - state.clipTime < 2000);
  $('#clip-l')?.classList.toggle('active', clipActive);
  $('#clip-r')?.classList.toggle('active', clipActive);
  if (!clipActive) state.clipDetected = false;

  // Stats text
  const rmsEl = $('#diag-rms');
  const peakEl = $('#diag-peak');
  const cpuEl = $('#diag-cpu');
  if (rmsEl) rmsEl.textContent = `RMS: ${rmsDb > -60 ? rmsDb.toFixed(1) : '-inf'} dB`;
  if (peakEl) peakEl.textContent = `Pk: ${peakDb > -60 ? peakDb.toFixed(1) : '-inf'} dB`;
  if (cpuEl && state.audioContext) {
    const latMs = ((state.audioContext.baseLatency || 0) * 1000).toFixed(1);
    cpuEl.textContent = `Lat: ${latMs}ms`;
  }
}

function clearDiagDisplay() {
  for (const id of ['scope-canvas', 'spectrum-canvas']) {
    const c = $(`#${id}`);
    if (c) {
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(0, 0, c.width, c.height);
    }
  }
  if ($('#meter-bar-l')) $('#meter-bar-l').style.width = '0%';
  if ($('#meter-bar-r')) $('#meter-bar-r').style.width = '0%';
  if ($('#meter-peak-l')) $('#meter-peak-l').style.left = '0%';
  if ($('#meter-peak-r')) $('#meter-peak-r').style.left = '0%';
  if ($('#diag-rms')) $('#diag-rms').textContent = 'RMS: --';
  if ($('#diag-peak')) $('#diag-peak').textContent = 'Pk: --';
  if ($('#diag-cpu')) $('#diag-cpu').textContent = 'Lat: --';
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

async function showApiKeyModal() {
  const modal = $('#api-key-modal');
  if (modal) {
    modal.classList.remove('hidden');
    for (const [id] of Object.entries(PROVIDERS)) {
      const input = $(`#key-${id}`);
      if (input) input.value = await getApiKey(id);
      const status = $(`#key-status-${id}`);
      if (status) status.textContent = (await getApiKey(id)) ? '\u2713' : '';
    }
    // Ollama URL field
    const ollamaUrlInput = $('#ollama-url');
    if (ollamaUrlInput) ollamaUrlInput.value = getOllamaUrl();

    // Compile server URL
    const compileUrlInput = $('#compile-server-url');
    if (compileUrlInput) compileUrlInput.value = state.remoteCompileUrl;

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

async function saveAllKeys() {
  for (const id of Object.keys(PROVIDERS)) {
    const input = $(`#key-${id}`);
    if (input) await setApiKey(id, input.value.trim());
  }
  // Save Ollama URL
  const ollamaUrlInput = $('#ollama-url');
  if (ollamaUrlInput) {
    setOllamaUrl(ollamaUrlInput.value.trim() || 'http://localhost:11434');
  }
  // Save compile server URL
  const compileUrlInput = $('#compile-server-url');
  if (compileUrlInput) {
    const url = compileUrlInput.value.trim().replace(/\/+$/, '');
    state.remoteCompileUrl = url;
    localStorage.setItem('daisy-gpt-compile-url', url);
  }
  hideApiKeyModal();
  updateUI();
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

// ─── Projects Panel ────────────────────────────────────────────────

function showProjects() {
  const overlay = $('#projects-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    renderProjectsList();
    // Sync current project name
    const nameInput = $('#project-name-input');
    if (nameInput && state.project) nameInput.value = state.project.name;
    const badge = $('#project-board-badge');
    if (badge && state.project) {
      const board = BOARDS[state.project.board];
      badge.textContent = board ? board.name : state.project.board;
    }
  }
}

function closeProjects() {
  const overlay = $('#projects-overlay');
  if (overlay) overlay.classList.add('hidden');
}

function renderProjectsList() {
  const list = $('#projects-list');
  if (!list) return;

  const projects = loadProjectsList();
  if (projects.length === 0) {
    list.innerHTML = '<div class="projects-empty">No saved projects yet.</div>';
    return;
  }

  list.innerHTML = projects.map(entry => {
    const date = new Date(entry.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' });
    const isCurrent = state.project && entry.name === state.project.name;
    return `<div class="projects-item${isCurrent ? ' active' : ''}" data-name="${escapeHtml(entry.name)}">
      <div class="projects-item-info">
        <span class="projects-item-name">${escapeHtml(entry.name)}</span>
        <span class="projects-item-meta">${entry.board} · ${entry.fileCount} file${entry.fileCount !== 1 ? 's' : ''} · ${date}</span>
      </div>
      <div class="projects-item-actions">
        ${isCurrent ? '<span class="projects-item-current">current</span>' : `<button class="btn btn-tiny projects-btn-open" data-name="${escapeHtml(entry.name)}">Open</button>`}
        <button class="btn btn-tiny btn-danger projects-btn-delete" data-name="${escapeHtml(entry.name)}" title="Delete project">&#x2715;</button>
      </div>
    </div>`;
  }).join('');

  // Open buttons
  list.querySelectorAll('.projects-btn-open').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchToProject(btn.dataset.name);
    });
  });

  // Delete buttons
  list.querySelectorAll('.projects-btn-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      if (confirm(`Delete project "${name}"?`)) {
        deleteProjectByName(name);
        if (state.project && state.project.name === name) {
          state.project = createProject('untitled', DEFAULT_BOARD);
          syncProjectToState();
          syncCodeToEditor();
          updateUI();
        }
        renderProjectsList();
      }
    });
  });
}

function switchToProject(name) {
  // Save current project first
  if (state.project) saveProject(state.project);

  const loaded = loadProjectByName(name);
  if (loaded) {
    state.project = loaded;
    // Also set as current
    localStorage.setItem('daisy-gpt-project', JSON.stringify(loaded));
    syncProjectToState();
    syncCodeToEditor();
    renderProjectFileTree();
    updateUI();
    updateKnobsForBoard();

    // Update board badge
    updateBoardBadge();

    showToast(`Opened "${name}"`);
    renderProjectsList();
  }
}

function handleProjectRename() {
  const nameInput = $('#project-name-input');
  if (!nameInput || !state.project) return;

  const newName = nameInput.value.trim();
  if (!newName || newName === state.project.name) {
    nameInput.value = state.project.name;
    return;
  }

  try {
    renameProject(state.project, newName);
    showToast(`Renamed to "${newName}"`);
    renderProjectsList();
  } catch (err) {
    showToast(err.message);
    nameInput.value = state.project.name;
  }
}

async function handleShareGist() {
  const tokenInput = $('#gist-token');
  const isPublic = $('#gist-public')?.checked || false;
  const token = tokenInput?.value?.trim();

  if (!token) {
    showToast('GitHub token required');
    return;
  }

  setGitHubToken(token);

  const btn = $('#btn-confirm-gist');
  if (btn) btn.textContent = 'Sharing...';

  try {
    const { url } = await createGist(state.project, token, isPublic);
    state.project.gistUrl = url;
    saveProject(state.project);

    const resultEl = $('#gist-result');
    const linkEl = $('#gist-result-link');
    if (resultEl && linkEl) {
      linkEl.href = url;
      linkEl.textContent = url;
      resultEl.classList.remove('hidden');
    }
    showToast('Shared on GitHub Gist!');
  } catch (err) {
    showToast(`Gist error: ${err.message}`);
  } finally {
    if (btn) btn.textContent = 'Share';
  }
}

async function handleImportGist() {
  const tokenInput = $('#gist-token');
  const urlInput = $('#gist-import-url');
  const token = tokenInput?.value?.trim();
  const gistUrl = urlInput?.value?.trim();

  if (!gistUrl) {
    showToast('Enter a Gist URL or ID');
    return;
  }

  if (token) setGitHubToken(token);

  const btn = $('#btn-confirm-gist');
  if (btn) btn.textContent = 'Importing...';

  try {
    const project = await loadFromGist(gistUrl, token);
    if (state.project) saveProject(state.project);

    state.project = project;
    syncProjectToState();
    syncCodeToEditor();
    renderProjectFileTree();
    saveProject(state.project);
    showToast(`Imported "${project.name}" from Gist`);
    updateUI();
    closeGistModal();
    closeProjects();
  } catch (err) {
    showToast(`Import error: ${err.message}`);
  } finally {
    if (btn) btn.textContent = state._gistMode === 'import' ? 'Import' : 'Share';
  }
}

function showGistModal(mode = 'share') {
  state._gistMode = mode;
  const modal = $('#gist-modal');
  const title = $('#gist-modal-title');
  const importRow = $('#gist-import-row');
  const publicRow = $('#gist-public-row');
  const confirmBtn = $('#btn-confirm-gist');
  const resultEl = $('#gist-result');

  if (modal) modal.classList.remove('hidden');
  if (resultEl) resultEl.classList.add('hidden');

  // Pre-fill token
  const tokenInput = $('#gist-token');
  if (tokenInput) tokenInput.value = getGitHubToken();

  if (mode === 'import') {
    if (title) title.textContent = 'Import from GitHub Gist';
    if (importRow) importRow.classList.remove('hidden');
    if (publicRow) publicRow.classList.add('hidden');
    if (confirmBtn) confirmBtn.textContent = 'Import';
  } else {
    if (title) title.textContent = 'Share on GitHub Gist';
    if (importRow) importRow.classList.add('hidden');
    if (publicRow) publicRow.classList.remove('hidden');
    if (confirmBtn) confirmBtn.textContent = 'Share';
  }
}

function closeGistModal() {
  const modal = $('#gist-modal');
  if (modal) modal.classList.add('hidden');
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

    if (state.armBinaryBytes) {
      const addr = parseInt(state.armTargetAddress, 16) || 0x90040000;
      dfu.log(`Flashing ARM binary (${state.armBinaryBytes.length} bytes) to ${state.armTargetAddress}...`);
      await dfu.flash(state.armBinaryBytes.buffer, addr);
    } else if (state.remoteCompileUrl && !state.armBinaryBytes) {
      dfu.log('No ARM binary available. Click "Compile for Daisy" first.');
      return;
    } else {
      dfu.log('No compile server configured. Set it in API Keys settings.');
      return;
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

  if (state.project && Object.keys(state.project.files).length > 1) {
    // Multi-file project — export as zip
    exportProjectZip(state.project);
  } else {
    const filename = state.project ? state.project.activeFile : 'patch.cpp';
    downloadFile(filename, state.code);
  }
}

/**
 * Update knob UI for the current board's knob count.
 */
function updateKnobsForBoard() {
  if (!state.project) return;
  const knobCount = getBoardKnobCount(state.project.board);

  // Show/hide knob rows based on board
  for (let i = 0; i < 8; i++) {
    const row = $(`#knob-${i}`)?.closest('.knob-row');
    if (row) {
      row.classList.toggle('hidden', i >= knobCount);
    }
  }

  // Ensure knobs array is the right size
  while (state.knobs.length < knobCount) {
    state.knobs.push(0.5);
    state.knobLabels.push(`Knob ${state.knobs.length}`);
  }
}

// ─── Board Badge & Wizard ─────────────────────────────────────────

/**
 * Update the board badge in the header to reflect the current project's target device.
 */
function updateBoardBadge() {
  const badge = $('#board-badge');
  if (badge && state.project) {
    const board = BOARDS[state.project.board];
    badge.textContent = board ? board.name : state.project.board;
    badge.title = board ? `Target: ${board.name} — ${board.description}` : 'Target device';
  }
}

/**
 * Show the board selection wizard modal. Returns a Promise that resolves with
 * the selected board ID, or null if cancelled.
 */
function showBoardWizard() {
  return new Promise((resolve) => {
    const modal = $('#board-wizard-modal');
    const grid = $('#board-wizard-grid');
    const detail = $('#board-wizard-detail');
    const confirmBtn = $('#btn-confirm-board-wizard');
    const cancelBtn = $('#btn-cancel-board-wizard');
    if (!modal || !grid) { resolve(null); return; }

    let selectedBoard = null;

    // Populate grid
    grid.innerHTML = '';
    for (const id of BOARD_IDS) {
      const board = BOARDS[id];
      const card = document.createElement('div');
      card.className = 'board-wizard-card';
      card.dataset.boardId = id;
      card.innerHTML = `
        <div class="board-wizard-card-name">${board.name}</div>
        <div class="board-wizard-card-desc">${board.description}</div>
      `;
      card.addEventListener('click', () => {
        // Deselect previous
        grid.querySelectorAll('.board-wizard-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedBoard = id;
        confirmBtn.disabled = false;

        // Show detail panel
        const detailName = $('#board-wizard-detail-name');
        const detailDesc = $('#board-wizard-detail-desc');
        const detailIO = $('#board-wizard-detail-io');
        if (detailName) detailName.textContent = board.name;
        if (detailDesc) detailDesc.textContent = board.description;
        if (detailIO) detailIO.textContent = getBoardIOSummary(id);
        detail.classList.remove('hidden');
      });
      grid.appendChild(card);
    }

    // Reset state
    selectedBoard = null;
    confirmBtn.disabled = true;
    detail.classList.add('hidden');

    // Show modal
    modal.classList.remove('hidden');

    // Handlers
    const cleanup = () => {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    };

    const onConfirm = () => {
      cleanup();
      resolve(selectedBoard);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
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
    if (statusEl) statusEl.textContent = state.project ? state.project.activeFile : 'patch.cpp';
  }
  updateCodeHighlight();
  renderProjectFileTree();
}

function updateCodeHighlight() {
  const codeEl = $('#code-highlight-code');
  if (!codeEl) return;
  const text = state.code || '';
  // Append a newline so the pre/code height always matches the textarea
  codeEl.textContent = text + (text.endsWith('\n') ? ' ' : '\n');
  delete codeEl.dataset.highlighted;
  if (window.hljs) hljs.highlightElement(codeEl);
}

function syncEditorToCode() {
  const editor = $('#code-editor');
  if (editor && !editor.readOnly) {
    state.code = editor.value;
    // Sync back to project
    if (state.project && state.project.activeFile) {
      updateFileContent(state.project, state.project.activeFile, state.code);
    }
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

  // Show file in the Files tab viewer (not the Code tab)
  const viewerWrap = $('#file-viewer-wrap');
  const browser = $('#file-browser');
  const pathEl = $('#file-viewer-path');
  const codeEl = $('#file-viewer-code');

  if (pathEl) pathEl.textContent = path;
  if (codeEl) {
    // Detect language from file extension
    const ext = path.split('.').pop().toLowerCase();
    const langMap = { h: 'cpp', hpp: 'cpp', cpp: 'cpp', c: 'cpp', cc: 'cpp' };
    const lang = langMap[ext] || '';
    codeEl.className = lang ? `language-${lang}` : '';
    codeEl.textContent = entry.content + '\n';
    delete codeEl.dataset.highlighted;
    if (window.hljs) hljs.highlightElement(codeEl);
  }

  if (browser) browser.classList.add('hidden');
  if (viewerWrap) viewerWrap.classList.remove('hidden');
}

// Apply edit from chat inline button
window._applyEditFromChat = function(btn) {
  const search = decodeURIComponent(atob(btn.dataset.search));
  const replace = decodeURIComponent(atob(btn.dataset.replace));
  const file = btn.dataset.file || (state.project ? state.project.activeFile : 'main.cpp');

  if (!state.code) {
    showToast('No code to edit');
    return;
  }

  const targetCode = state.project?.files[file]?.content || state.code;
  const { code, results } = applyEdits([{ file, search, replace }], targetCode);
  if (results[0]?.ok) {
    state.previousCode = state.code;
    if (state.project) {
      updateFileContent(state.project, file, code);
      syncProjectToState();
      saveProject(state.project);
    } else {
      state.code = code;
    }
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
  const highlight = $('#code-highlight');
  let highlightTimer;
  if (editor) {
    editor.addEventListener('input', () => {
      if (!editor.readOnly) {
        syncEditorToCode();
        const codeEl = $('#code-highlight-code');
        if (codeEl) {
          const text = state.code || '';
          codeEl.textContent = text + (text.endsWith('\n') ? ' ' : '\n');
        }
        clearTimeout(highlightTimer);
        highlightTimer = setTimeout(updateCodeHighlight, 150);
      }
    });

    // Sync scroll between textarea and highlight overlay
    editor.addEventListener('scroll', () => {
      if (highlight) {
        highlight.scrollTop = editor.scrollTop;
        highlight.scrollLeft = editor.scrollLeft;
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

  // File viewer close button — return to file browser
  $('#file-viewer-close')?.addEventListener('click', () => {
    state.viewingFile = null;
    const viewerWrap = $('#file-viewer-wrap');
    const browser = $('#file-browser');
    if (viewerWrap) viewerWrap.classList.add('hidden');
    if (browser) browser.classList.remove('hidden');
  });
}

// ─── Event Binding ─────────────────────────────────────────────────

async function init() {
  // Initialize project — load saved or create new
  const savedProject = loadProject();
  if (savedProject) {
    state.project = savedProject;
  } else {
    // Check for legacy single-file code
    const legacyCode = localStorage.getItem('daisy-gpt-code') || '';
    if (legacyCode) {
      state.project = migrateFromLegacy(legacyCode);
    } else {
      state.project = createProject('untitled', DEFAULT_BOARD);
    }
  }

  // Check for shared project URL
  if (window.location.hash) {
    const urlProject = importProjectURL(window.location.hash);
    if (urlProject) {
      state.project = urlProject;
      showToast('Loaded shared project');
      window.location.hash = '';
    }
  }

  syncProjectToState();

  // Display board badge (read-only — board is locked at project creation)
  updateBoardBadge();

  // Initialize knobs for current board
  updateKnobsForBoard();

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
    const boardName = BOARDS[state.project?.board]?.name || 'Daisy';
    if (container) {
      container.innerHTML = `
        <div class="chat-welcome">
          <div class="chat-welcome-logo">daisy-gpt</div>
          <p>I'm your ${boardName} AI pair programmer. Describe what you want to build and I'll help you code it, compile it, and play it right here.</p>
          <p class="chat-welcome-hint">Try: "acid bassline with resonant filter" or "help me debug this compile error"</p>
        </div>`;
    }
  });

  // Undo
  $('#btn-undo')?.addEventListener('click', () => {
    if (state.previousCode) {
      if (state.project) {
        updateFileContent(state.project, state.project.activeFile, state.previousCode);
        syncProjectToState();
      } else {
        state.code = state.previousCode;
      }
      state.previousCode = '';
      syncCodeToEditor();
      updateUI();
      compileCode();
    }
  });

  // Export project as zip
  $('#btn-export-zip')?.addEventListener('click', () => {
    if (state.project) exportProjectZip(state.project);
  });

  // Import project from zip
  $('#btn-import-zip')?.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        state.project = await importProjectZip(file);
        syncProjectToState();
        syncCodeToEditor();
        renderProjectFileTree();
        saveProject(state.project);
        showToast(`Imported "${state.project.name}"`);
        updateUI();
      } catch (err) {
        showToast(`Import failed: ${err.message}`);
      }
    };
    input.click();
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

  // Projects
  $('#btn-projects')?.addEventListener('click', showProjects);
  $('#btn-close-projects')?.addEventListener('click', closeProjects);
  $('#btn-new-project')?.addEventListener('click', async () => {
    const boardId = await showBoardWizard();
    if (!boardId) return; // User cancelled

    if (state.project) saveProject(state.project);
    state.project = createProject('untitled', boardId);
    syncProjectToState();
    syncCodeToEditor();
    renderProjectFileTree();
    saveProject(state.project);
    showToast(`Created new project for ${BOARDS[boardId].name}`);
    renderProjectsList();
    updateUI();
    updateBoardBadge();
    updateKnobsForBoard();
    const nameInput = $('#project-name-input');
    if (nameInput) { nameInput.value = state.project.name; nameInput.select(); }
    const badge = $('#project-board-badge');
    if (badge) badge.textContent = BOARDS[boardId]?.name || boardId;
  });
  $('#project-name-input')?.addEventListener('change', handleProjectRename);
  $('#project-name-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.target.blur(); handleProjectRename(); }
  });
  $('#btn-duplicate-project')?.addEventListener('click', () => {
    if (!state.project) return;
    const newName = state.project.name + '-copy';
    const copy = duplicateProject(state.project, newName);
    showToast(`Duplicated as "${newName}"`);
    renderProjectsList();
  });
  $('#btn-share-url')?.addEventListener('click', () => {
    if (!state.project) return;
    try {
      const url = exportProjectURL(state.project);
      navigator.clipboard.writeText(url).then(() => showToast('Shareable URL copied!'));
    } catch (err) {
      showToast(err.message);
    }
  });
  $('#btn-share-gist')?.addEventListener('click', () => showGistModal('share'));
  $('#btn-import-gist')?.addEventListener('click', () => showGistModal('import'));

  // Gist modal
  $('#btn-confirm-gist')?.addEventListener('click', () => {
    if (state._gistMode === 'import') handleImportGist();
    else handleShareGist();
  });
  $('#btn-cancel-gist')?.addEventListener('click', closeGistModal);

  // DFU
  $('#btn-close-dfu')?.addEventListener('click', closeDfuOverlay);

  // Close modals on backdrop click
  $('#api-key-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'api-key-modal') hideApiKeyModal();
  });
  $('#history-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'history-overlay') closeHistory();
  });
  $('#projects-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'projects-overlay') closeProjects();
  });
  $('#gist-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'gist-modal') closeGistModal();
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
  for (let i = 0; i < 8; i++) {
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

  // Signal Generator
  initSignalGenerator();

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

  // Compile button
  $('#btn-compile')?.addEventListener('click', async () => {
    if (!state.code) return;
    state.compileRetries = 0;
    await compileCode();
  });

  // Load compiler button
  $('#btn-load-compiler')?.addEventListener('click', () => {
    loadCompiler();
  });

  // ARM compile button
  $('#btn-arm-compile')?.addEventListener('click', () => {
    compileForDaisy();
  });

  // Code panel & tabs
  initCodePanel();

  // Audio Input/Output Setup
  initAudioInput();
  initAudioOutput();

  // MIDI Setup
  initMIDI();

  // Diagnostics
  initDiagnostics();

  // Initialise encrypted key store and migrate old keys
  await initKeyStore();
  await migrateOldKey();

  // Set provider dropdown
  const providerSelect = $('#provider-select');
  if (providerSelect) providerSelect.value = state.provider;

  // Populate model dropdown and thinking controls
  populateModelDropdown();
  updateThinkingControls();

  // Show API key modal if no key
  if (!(await currentApiKey())) {
    setTimeout(showApiKeyModal, 500);
  }

  // Initial UI state
  updateUI();
  setStatus('', 'Ready');
}

// ─── Boot ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
