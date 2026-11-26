// Kashu's agent's head: a model on NEAR AI Cloud running inside an attested TEE (Intel TDX + NVIDIA GPUs), which turns
// what a saver types into proposed chores. It holds no keys and can't act: the app shows the proposal in plain words,
// the saver approves it with their passkey, and the vault enforces it. The model is checked before it's trusted
// (attest.mjs) and every answer is checked to come from that same enclave (checkAnswer).
import { attest, checkAnswer, BASE } from './attest.mjs';

export const MODEL = process.env.NEAR_AI_MODEL || 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
/** The model's prices on NEAR AI (USD per million tokens), from /v1/models on 2026-11-23. */
const PRICE = { input: Number(process.env.PRICE_IN || 0.3), output: Number(process.env.PRICE_OUT || 1.2), cached: Number(process.env.PRICE_CACHED || 0.006) };
const SYSTEM = `You are the helper inside Kashu, a savings app where friends save together each payday and a free weekly draw pays a prize from interest. You set up weekly chores for the saver and nothing else.
Chores you can propose (at most 4, each runs once a week):
- save: put an amount of dollars into their savings vault (earns interest).
- save_private: put an amount into their private pocket (no interest; nobody can see the balance).
- pay: send an amount to a friend by Kashutag (like $ada).
- remind: a notification on a weekday and hour if they haven't saved that week.
Rules: amounts are in US dollars, at most 50 each; weekdays are monday to sunday; hours are 0-23 in the saver's local time. Pick a weekly_cap that covers the chores' total (at most 100). If something is missing (an amount, a day, who to pay), ask one short question instead of guessing. You can't withdraw money, invest, give financial advice, or do anything outside these chores: say so kindly if asked. Reply in one or two short plain sentences, no jargon, and never use em dashes or en dashes. When you have everything, call propose_chores.`;
const TOOLS = [{
  type: 'function',
  function: {
    name: 'propose_chores',
    description: 'Propose the saver\'s weekly chores. The app shows them in plain words and the saver approves them with their passkey.',
    parameters: {
      type: 'object',
      properties: {
        weekly_cap: { type: 'number', description: 'Most the agent may move in a week, in dollars' },
        chores: {
          type: 'array', maxItems: 4,
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['save', 'save_private', 'pay', 'remind'] },
              amount: { type: 'number', description: 'Dollars (not for remind)' },
              weekday: { type: 'string', enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
              hour: { type: 'integer', minimum: 0, maximum: 23, description: 'Local hour' },
              to: { type: 'string', description: 'For pay: the friend\'s Kashutag, like $ada' },
            },
            required: ['kind', 'weekday', 'hour'],
          },
        },
      },
      required: ['weekly_cap', 'chores'],
    },
  },
}];

let cached = null;
/** The model's attestation, re-checked every ten minutes. */
export async function attestation(key) {
  if (!cached || Date.now() - cached.at > 600_000) cached = { at: Date.now(), result: await attest(MODEL, key) };
  return cached.result;
}

/** One turn of the chat: the saver's messages in, a reply and (when ready) a proposal out, with proof it came from the enclave. */
export async function chat({ key, messages }) {
  const att = await attestation(key);
  if (!att.passed) throw Object.assign(new Error('The private AI failed its enclave check just now, so Kashu won\'t use it. Try again in a few minutes.'), { status: 503 });
  const clean = messages.slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content ?? '').slice(0, 600) }));
  const requestBody = JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: SYSTEM }, ...clean], tools: TOOLS, temperature: 0, max_tokens: 600 });
  const r = await fetch(`${BASE}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: requestBody, signal: AbortSignal.timeout(60_000) });
  const responseText = await r.text();
  if (!r.ok) throw Object.assign(new Error(`The private AI didn't answer (${r.status})`), { status: 502 });
  const out = JSON.parse(responseText);
  const proof = await checkAnswer({ model: MODEL, key, chatId: out.id, requestBody, responseText, signers: att.signers, gateway: att.gateway });
  if (!proof.passed) throw Object.assign(new Error('That answer wasn\'t signed by the checked enclave, so Kashu dropped it.'), { status: 502 });
  const msg = out.choices[0].message;
  const call = msg.tool_calls?.find((t) => t.function?.name === 'propose_chores');
  let proposal = null;
  if (call) { try { proposal = JSON.parse(call.function.arguments || '{}'); } catch { proposal = null; } }
  // Kashu's copy never uses em or en dashes, whatever the model writes
  if (msg.content) msg.content = msg.content.replace(/\s*[\u2014\u2013]\s*/g, ', ');
  // what this answer cost, from the provider's own token counts (USD per million tokens; cached input is far cheaper)
  const u = out.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = ((u.prompt_tokens ?? 0) - cached) * PRICE.input / 1e6 + cached * PRICE.cached / 1e6 + (u.completion_tokens ?? 0) * PRICE.output / 1e6;
  return { cost, reply: msg.content || (proposal ? 'Here is what I\'d set up. Check it, then approve with your passkey.' : ''), proposal, proof: { model: MODEL, enclave: proof.kind, signer: proof.signer } };
}

/** What the app's "verified private" badge shows: each check, passed or not, and when. */
export async function badge(key) {
  const a = await attestation(key);
  return { passed: a.passed, model: MODEL, checkedAt: new Date(cached.at).toISOString(), checks: a.checks.map((c) => ({ name: c.name, pass: c.pass })) };
}
