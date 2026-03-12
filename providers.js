// daisy-gpt — multi-provider LLM support
// Anthropic, OpenAI (Responses API), OpenRouter (Chat Completions)

export const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keySlot: 'daisy-gpt-anthropic-key',
    models: [
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    ],

    async call(apiKey, model, systemPrompt, messages, onToken, signal) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      await readSSE(response, (event) => {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          onToken(event.delta.text);
        }
      });
    },

    async callSync(apiKey, model, systemPrompt, messages) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: systemPrompt,
          messages,
        }),
      });

      if (!response.ok) throw new Error(`API error ${response.status}`);
      const data = await response.json();
      return data.content[0]?.text || '';
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
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'o3', label: 'o3' },
      { id: 'o4-mini', label: 'o4-mini' },
    ],

    async call(apiKey, model, systemPrompt, messages, onToken, signal) {
      const input = [];
      input.push({ role: 'developer', content: systemPrompt });
      for (const m of messages) {
        input.push({ role: m.role, content: m.content });
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          input,
          stream: true,
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error ${response.status}`);
      }

      await readSSE(response, (event) => {
        if (event.type === 'response.output_text.delta' && event.delta) {
          onToken(event.delta);
        }
      });
    },

    async callSync(apiKey, model, systemPrompt, messages) {
      const input = [];
      input.push({ role: 'developer', content: systemPrompt });
      for (const m of messages) {
        input.push({ role: m.role, content: m.content });
      }

      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input }),
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
      { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6' },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
      { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini' },
      { id: 'google/gemini-3-flash-preview', label: 'Gemini 3 Flash' },
      { id: 'deepseek/deepseek-v3.2', label: 'DeepSeek V3.2' },
      { id: 'openai/o3', label: 'o3' },
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

// Get the current API key for a provider
export function getApiKey(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return '';
  return localStorage.getItem(provider.keySlot) || '';
}

// Save an API key for a provider
export function setApiKey(providerId, key) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;
  localStorage.setItem(provider.keySlot, key);
}

// Migrate old single key to anthropic slot
export function migrateOldKey() {
  const old = localStorage.getItem('daisy-gpt-api-key');
  if (old && !localStorage.getItem('daisy-gpt-anthropic-key')) {
    localStorage.setItem('daisy-gpt-anthropic-key', old);
  }
}
