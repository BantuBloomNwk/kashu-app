import { plain } from './plain.ts';
import { useEffect, useRef, useState } from 'react';
import { money } from '../ui/money.ts';
import { AGENT_URL, readAgent, setupAgent, stopAgent, toLocal, type AgentState, type Proposal } from './live.ts';
import { useStore } from './store.ts';

type Msg = { role: 'user' | 'assistant'; content: string };
const KIND = ['', 'Save', 'Save privately', 'Pay', 'Remind me'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const at = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;

/** The live enclave check behind the agent: shown as a badge, with every check one tap away. */
function Verified() {
  const [b, setB] = useState<{ passed: boolean; model: string; checkedAt: string; checks: { name: string; pass: boolean }[] } | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => { fetch(`${AGENT_URL}/attestation`).then((r) => (r.ok ? r.json() : Promise.reject())).then(setB, () => setErr(true)); }, []);
  if (err) return <p className="agent-badge off">Private AI is offline right now. Your chores still run.</p>;
  if (!b) return <p className="agent-badge">Checking the private AI…</p>;
  return (
    <details className={`agent-badge ${b.passed ? 'ok' : 'off'}`}>
      <summary>{b.passed ? 'Private AI, verified just now' : 'Private AI failed its check: Kashu won\'t use it'}</summary>
      <p>Your words go to an AI running inside sealed hardware (Intel TDX with NVIDIA GPUs) on NEAR AI. Kashu checks the hardware's proof before every chat, and checks each answer was signed inside it. Kashu keeps nothing you type.</p>
      <ul>{b.checks.map((c) => <li key={c.name} className={c.pass ? 'pass' : 'fail'}>{c.name}</li>)}</ul>
      <small>{b.model} · checked {new Date(b.checkedAt).toLocaleTimeString()}</small>
    </details>
  );
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="proposal">
      <b>Your agent would, each week:</b>
      <ul>{p.chores.map((c, i) => <li key={i}>{cap(c.weekday)} at {at(c.hour)}: {c.kind === 'remind' ? 'remind you if you haven\'t saved' : `${KIND[{ save: 1, save_private: 2, pay: 3, remind: 4 }[c.kind]]} ${money(c.amount ?? 0)}${c.kind === 'pay' ? ` to ${c.to}` : ''}`}</li>)}</ul>
      <p className="hint">At most {money(p.weekly_cap)} a week, enforced by your vault on Solana. It can never take money out, change your pocket or pay anyone you didn't name. Kashu charges 1¢ each time a chore runs (reminders are free).</p>
      <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={async () => { setBusy('One moment…'); try { if (await setupAgent(p)) onDone(); setBusy(null); } catch (e) { setBusy(plain(e)); } }}>{busy === 'One moment…' ? busy : 'Approve with my passkey'}</button>
      {busy && busy !== 'One moment…' && <p className="review-error" role="alert">{busy}</p>}
    </div>
  );
}

export function Agent() {
  const s = useStore();
  const [state, setState] = useState<AgentState>(null);
  const [msgs, setMsgs] = useState<Msg[]>([{ role: 'assistant', content: 'Hi! Tell me a chore, like "save $5 every Friday evening" or "pay $ada $10 on Mondays". I\'ll set it up for you to approve.' }]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = () => readAgent().then(setState, () => setState(null));
  useEffect(() => { if (s.live) load(); }, [s.live?.wallet]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [msgs, proposal]);
  if (!s.live) return <div className="agent"><h1>Your agent</h1><p className="hint">Start your room first.</p></div>;

  const send = async (said?: string) => {
    const t = (said ?? text).trim(); if (!t || thinking) return;
    const next: Msg[] = [...msgs, { role: 'user', content: t }];
    setMsgs(next); setText(''); setThinking(true); setProposal(null);
    try {
      const r = await fetch(`${AGENT_URL}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: s.live!.wallet, messages: next.slice(1) }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'The agent didn\'t answer');
      setMsgs([...next, { role: 'assistant', content: j.reply || 'Here it is.' }]);
      if (j.proposal?.chores?.length) setProposal(j.proposal);
    } catch (e) { setMsgs([...next, { role: 'assistant', content: plain(e) }]); }
    finally { setThinking(false); }
  };

  return (
    <div className="agent">
      <div className="agent-head"><h1>Your agent</h1><Verified /></div>
      {state?.on && state.chores.length > 0 && (
        <section className="me-card" aria-labelledby="chores-h">
          <h2 id="chores-h">Running for you</h2>
          <ul className="chores">{state.chores.map((c, i) => { const l = toLocal(c.weekday, c.hour); return (
            <li key={i}><b>{KIND[c.kind]}{c.kind !== 4 ? ` ${money(c.amount)}` : ''}{c.to ? ` to ${c.to}` : ''}</b><span>{l.day}s at {at(l.hour)}{c.lastRun ? ` · last ran ${new Date(c.lastRun * 1000).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ' · not yet'}</span></li>); })}</ul>
          <p className="hint">{money(state.spent)} of {money(state.cap)} used this week.</p>
          <button className="btn btn-ghost btn-sm" onClick={async () => { if (await stopAgent().catch(() => null)) load(); }}>Turn my agent off</button>
        </section>
      )}
      <div className="chat" aria-live="polite">
        {msgs.map((m, i) => <p key={i} className={`bubble ${m.role}`}>{m.content}</p>)}
        {msgs.length === 1 && !thinking && (
          <div className="suggest" role="group" aria-label="Ideas to start with">
            {['Save $5 every Friday at 6pm', 'Save $10 privately on payday Friday', 'Pay $ada $10 every Monday', 'Remind me Thursdays if I haven\'t saved'].map((x) => (
              <button key={x} type="button" className="chip" onClick={() => send(x)}>{x}</button>
            ))}
          </div>
        )}
        {thinking && <p className="bubble assistant thinking" aria-label="Thinking"><span /><span /><span /></p>}
        {proposal && <ProposalCard p={proposal} onDone={() => { setProposal(null); setMsgs((m) => [...m, { role: 'assistant', content: 'Done. I\'ll take it from here, and you can turn me off any time.' }]); load(); }} />}
        <div ref={end} />
      </div>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Save $5 every Friday at 6pm" aria-label="Tell your agent a chore" maxLength={400} />
        <button className="btn btn-primary btn-sm" disabled={!text.trim() || thinking}>Send</button>
      </form>
    </div>
  );
}
