// Claude drafting through the Anthropic Messages API, called straight from the browser
// with the user's own API key (stored only in this browser). Same call shape as before:
//   const { text } = await sample(prompt, { signal, onText })
//   const value = await sample.json(prompt)

export const MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (balanced)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (best writing, slower)'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (fastest, cheapest)'],
];
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function err(code, message, extra) { return Object.assign(new Error(message || code), { code }, extra || {}); }

async function toError(res) {
  let msg = ''; try { const j = await res.json(); msg = (j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
  if (res.status === 401) return err('bad_key', msg);
  if (res.status === 403) return err('forbidden', msg);
  if (res.status === 429) return err('rate_limited', msg);
  if (res.status === 400 && /credit|billing|balance/i.test(msg)) return err('no_credit', msg);
  if (res.status === 400 && /model/i.test(msg)) return err('bad_model', msg);
  if (res.status === 400 || res.status === 413) return err('invalid_request', msg);
  return err('upstream_error', msg || ('HTTP ' + res.status));
}

export function makeSample(getSettings) {
  async function sample(input, opts = {}) {
    const s = getSettings();
    if (!s.apiKey) throw err('no_key');
    const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    const stream = typeof opts.onText === 'function';
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST', signal: opts.signal,
        headers: {
          'content-type': 'application/json', 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({ model: s.model || MODELS[0][0], max_tokens: opts.maxTokens || 4000, messages, stream }),
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw err('cancelled');
      throw err('network', 'Could not reach the Anthropic API. Check your connection.');
    }
    if (!res.ok) throw await toError(res);
    if (!stream) {
      const j = await res.json();
      const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (!text) throw err('empty_completion');
      return { text, truncated: j.stop_reason === 'max_tokens' };
    }
    // Server-sent events
    const reader = res.body.getReader(); const dec = new TextDecoder();
    let buf = '', text = '', stop = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
          if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            text += ev.delta.text; opts.onText({ text, delta: ev.delta.text });
          } else if (ev.type === 'message_delta' && ev.delta) stop = ev.delta.stop_reason || stop;
          else if (ev.type === 'error') throw err('upstream_error', ev.error && ev.error.message, { text });
        }
      }
    } catch (e) {
      if (e && e.name === 'AbortError') throw err('cancelled', '', { text });
      throw e.code ? e : err('network', e.message, { text });
    }
    if (!text) throw err('empty_completion');
    return { text, truncated: stop === 'max_tokens' };
  }

  sample.json = async function (input, opts = {}) {
    const prompt = (typeof input === 'string' ? input : '') + '\n\nYour reply is parsed by a program: output only the JSON value, with no prose and no code fences.';
    const { text, truncated } = await sample(prompt, Object.assign({}, opts, { onText: undefined }));
    if (truncated) throw err('invalid_json', 'Reply was cut short', { text });
    const tryParse = s => { try { return JSON.parse(s); } catch (e) { return undefined; } };
    let v = tryParse(text.trim());
    if (v === undefined) { const m = text.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) v = tryParse(m[1].trim()); }
    if (v === undefined) {
      const a = Math.min(...['{', '['].map(c => { const k = text.indexOf(c); return k < 0 ? Infinity : k; }));
      const b = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
      if (a < Infinity && b > a) v = tryParse(text.slice(a, b + 1));
    }
    if (v === undefined) throw err('invalid_json', 'Reply was not JSON', { text });
    return v;
  };
  return sample;
}

export function aiErrorMessage(e) {
  const c = e && e.code;
  if (c === 'no_key') return 'Add your Anthropic API key in Settings to draft with Claude.';
  if (c === 'bad_key') return 'Anthropic rejected the API key. Check it in Settings.';
  if (c === 'no_credit') return 'Your Anthropic account has no credit left. Top up at console.anthropic.com.';
  if (c === 'bad_model') return 'That model is not available on your key. Pick another one in Settings.';
  if (c === 'rate_limited') return 'Too many requests at once. Wait a few seconds and try again.';
  if (c === 'invalid_json') return 'Claude answered in an unexpected format. Try again.';
  if (c === 'cancelled') return 'Stopped.';
  if (c === 'network') return 'Could not reach the Anthropic API. Check your connection.';
  if (c === 'forbidden') return 'Your API key is not allowed to do this. Check its permissions.';
  return 'Claude could not answer just now' + (e && e.message ? ` (${e.message})` : '') + '.';
}
