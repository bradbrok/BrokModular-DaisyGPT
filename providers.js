// daisy-gpt — multi-provider LLM support
// Anthropic, OpenAI (Responses API), OpenRouter (Chat Completions), Ollama (Local)

import { initCryptoStore, encryptValue, decryptValue, isEncryptedEnvelope } from './crypto-store.js';

const OLLAMA_CORS_HINT = 'Cannot reach Ollama. Make sure it\'s running and started with OLLAMA_ORIGINS=* for browser access.';

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keySlot: 'daisy-gpt-anthropic-key',
    models: [
      { id: 'claude-opus-4-6', label: 'Opus 4.6', thinking: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', thinking: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', thinking: true },
    ],

    async call(apiKey, model, systemPrompt, messages, onToken, signal, options = {}) {
      const body = {
        model,
        max_tokens: options.thinking ? Math.max(16000, (options.budgetTokens || 10000) + 4096) : 4096,
        system: systemPrompt,
        messages,
        stream: true,
      };
      if (options.thinking) {
        body.thinking = { type: 'enabled', budget_tokens: options.budgetTokens || 10000 };
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      let currentBlockType = null;
      await readSSE(response, (event) => {
        if (event.type === 'content_block_start') {
          currentBlockType = event.content_block?.type;
        } else if (event.type === 'content_block_delta') {
          if (currentBlockType === 'thinking' && event.delta?.thinking && options.onThinking) {
            options.onThinking(event.delta.thinking);
          } else if (event.delta?.text) {
            onToken(event.delta.text);
          }
        } else if (event.type === 'content_block_stop') {
          currentBlockType = null;
        }
      });
    },

    async callSync(apiKey, model, systemPrompt, messages, options = {}) {
      const body = {
        model,
        max_tokens: options.thinking ? Math.max(16000, (options.budgetTokens || 10000) + 4096) : 4096,
        system: systemPrompt,
        messages,
      };
      if (options.thinking) {
        body.thinking = { type: 'enabled', budget_tokens: options.budgetTokens || 10000 };
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      const textBlock = data.content.find(b => b.type === 'text');
      return textBlock?.text || data.content[0]?.text || '';
    },

    async test(apiKey) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
    },
  },

  openai: {
    name: 'OpenAI',
    keySlot: 'daisy-gpt-openai-key',
    models: [
      { id: 'gpt-5.4', label: 'GPT-5.4', reasoning: true },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini', reasoning: true },
      { id: 'o3', label: 'o3', reasoning: true },
      { id: 'o4-mini', label: 'o4-mini', reasoning: true },
    ],

    async call(apiKey, model, systemPrompt, messages, onToken, signal, options = {}) {
      const input = [];
      input.push({ role: 'developer', content: systemPrompt });
      for (const m of messages) {
        input.push({ role: m.role, content: m.content });
      }

      const body = { model, input, stream: true };
      const modelDef = this.models.find(m => m.id === model);
      if (options.thinking && modelDef?.reasoning) {
        body.reasoning = { effort: options.reasoningEffort || 'medium' };
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      await readSSE(response, (event) => {
        if (event.type === 'response.output_text.delta' && event.delta) {
          onToken(event.delta);
        }
        if (event.type === 'response.reasoning_summary_text.delta' && event.delta && options.onThinking) {
          options.onThinking(event.delta);
        }
      });
    },

    async callSync(apiKey, model, systemPrompt, messages, options = {}) {
      const input = [];
      input.push({ role: 'developer', content: systemPrompt });
      for (const m of messages) {
        input.push({ role: m.role, content: m.content });
      }

      const body = { model, input };
      const modelDef = this.models.find(m => m.id === model);
      if (options.thinking && modelDef?.reasoning) {
        body.reasoning = { effort: options.reasoningEffort || 'medium' };
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      return data.output?.[0]?.content?.[0]?.text || '';
    },

    async test(apiKey) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-5-mini',
          input: 'hi',
        }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
    },
  },

  openrouter: {
    name: 'OpenRouter',
    keySlot: 'daisy-gpt-openrouter-key',
    models: [
      { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6', thinking: true },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', thinking: true },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4', reasoning: true },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', reasoning: true },
      { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'openai/o3', label: 'o3', reasoning: true },
    ],

    async call(apiKey, model, systemPrompt, messages, onToken, signal) {
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/bradbrok/daisy-gpt',
          'X-Title': 'daisy-gpt',
        },
        body: JSON.stringify({
          model,
          messages: chatMessages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      await readSSE(response, (event) => {
        const content = event.choices?.[0]?.delta?.content;
        if (content) onToken(content);
      });
    },

    async callSync(apiKey, model, systemPrompt, messages) {
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/bradbrok/daisy-gpt',
          'X-Title': 'daisy-gpt',
        },
        body: JSON.stringify({ model, messages: chatMessages }),
      });

      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    },

    async test(apiKey) {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/bradbrok/daisy-gpt',
          'X-Title': 'daisy-gpt',
        },
        body: JSON.stringify({
          model: 'openai/gpt-5-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      if (!response.ok) throw new Error(`${response.status}`);
    },
  },

  ollama: {
    name: 'Ollama (Local)',
    keySlot: 'daisy-gpt-ollama-key',
    models: [],

    getBaseUrl() {
      return localStorage.getItem('daisy-gpt-ollama-url') || 'http://localhost:11434';
    },

    async fetchModels() {
      let response;
      try {
        response = await fetch(`${this.getBaseUrl()}/api/tags`);
      } catch (e) {
        throw new Error(OLLAMA_CORS_HINT);
      }
      if (!response.ok) throw new Error(`Ollama error ${response.status}`);
      const data = await response.json();
      const models = data.models || [];
      if (models.length === 0) {
        throw new Error('Ollama is running but has no models. Run: ollama pull llama3.1');
      }
      this.models = models.map(m => {
        const size = m.details?.parameter_size || '';
        const quant = m.details?.quantization_level || '';
        const extra = [size, quant].filter(Boolean).join(' ');
        return {
          id: m.name,
          label: extra ? `${m.name} (${extra})` : m.name,
        };
      });
      return this.models;
    },

    async call(apiKey, model, systemPrompt, messages, onToken, signal) {
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      let response;
      try {
        response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
          method: 'POST',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: chatMessages,
            stream: true,
          }),
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new Error(OLLAMA_CORS_HINT);
      }

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `Ollama error ${response.status}`);
      }

      await readSSE(response, (event) => {
        const content = event.choices?.[0]?.delta?.content;
        if (content) onToken(content);
      });
    },

    async callSync(apiKey, model, systemPrompt, messages) {
      const chatMessages = [
        { role: 'system', content: systemPrompt },
        ...messages,
      ];

      let response;
      try {
        response = await fetch(`${this.getBaseUrl()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages: chatMessages }),
        });
      } catch (e) {
        throw new Error(OLLAMA_CORS_HINT);
      }

      if (!response.ok) throw new Error(`Ollama error ${response.status}`);
      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    },

    async test() {
      let response;
      try {
        response = await fetch(`${this.getBaseUrl()}/api/tags`);
      } catch (e) {
        throw new Error(OLLAMA_CORS_HINT);
      }
      if (!response.ok) throw new Error(`Ollama error ${response.status}`);
    },
  },
};

// Shared SSE reader
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch (e) {
          // skip unparseable
        }
      }
    }
  }
}

// Initialise the encrypted key store (call once at startup)
export async function initKeyStore() {
  await initCryptoStore();
}

// Get the current API key for a provider (decrypts if needed)
export async function getApiKey(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return '';
  const raw = localStorage.getItem(provider.keySlot);
  if (!raw) return '';

  if (isEncryptedEnvelope(raw)) {
    try {
      return await decryptValue(raw);
    } catch {
      // Encryption key lost (IndexedDB cleared) — remove corrupt entry
      localStorage.removeItem(provider.keySlot);
      return '';
    }
  }
  return raw;
}

// Save an API key for a provider (encrypts before storing)
export async function setApiKey(providerId, key) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  if (!key) {
    localStorage.removeItem(provider.keySlot);
    return;
  }
  const encrypted = await encryptValue(key);
  localStorage.setItem(provider.keySlot, encrypted);
}

// Ollama URL helpers (not secrets — stay plaintext)
export function getOllamaUrl() {
  return localStorage.getItem('daisy-gpt-ollama-url') || 'http://localhost:11434';
}

export function setOllamaUrl(url) {
  localStorage.setItem('daisy-gpt-ollama-url', url.replace(/\/+$/, ''));
}

// Migrate old single key to anthropic slot + encrypt any plaintext keys
export async function migrateOldKey() {
  const old = localStorage.getItem('daisy-gpt-api-key');
  if (old && !localStorage.getItem('daisy-gpt-anthropic-key')) {
    localStorage.setItem('daisy-gpt-anthropic-key', old);
  }

  // Encrypt any remaining plaintext keys
  for (const [, provider] of Object.entries(PROVIDERS)) {
    if (!provider.keySlot) continue;
    const raw = localStorage.getItem(provider.keySlot);
    if (raw && !isEncryptedEnvelope(raw)) {
      const encrypted = await encryptValue(raw);
      localStorage.setItem(provider.keySlot, encrypted);
    }
  }

  // Remove legacy key after migration
  if (old) localStorage.removeItem('daisy-gpt-api-key');
}
