import { useEffect, useRef, useState } from 'react';
import { Mark, Moon, Sun, Wordmark } from '../ui/Mark.tsx';
import { Phone } from '../ui/Phone.tsx';
import { KernelRow, Wall, type Friend } from '../ui/Wall.tsx';
import { PRIZE, local, money, weeklyDefault } from '../ui/money.ts';
import { Odometer, Reveal, SplitFlap, Sweep, reduceMotion as reduce, useInView, useScrollVar, useTilt } from '../ui/motion.tsx';
import { PoweredBy } from '../ui/Partners.tsx';
import CREDITS from './photos.json';
import './landing.css';
import { MAINNET } from '../config.ts';

/** Numbered section label, as in a printed programme: "01  How a week goes". */
const Label = ({ n, children, tone = '' }: { n: string; children: string; tone?: string }) => (
  <span className={`kicker label ${tone}`}><span className="label-n">{n}</span>{children}</span>
);

const ROOM: Friend[] = [
  { id: 'ada', name: 'Ada', lit: false, streak: 4, pattern: 'louvre' },
  { id: 'tunde', name: 'Tunde', lit: false, streak: 6, pattern: 'panel' },
  { id: 'kemi', name: 'Kemi', lit: false, streak: 0, pattern: 'lattice' },
  { id: 'wanjiru', name: 'Wanjiru', lit: false, streak: 3, pattern: 'grid' },
  { id: 'you', name: 'You', lit: false, streak: 2, pattern: 'panel', you: true },
  { id: 'paolo', name: 'Paolo', lit: false, streak: 5, pattern: 'louvre' },
];
const FIRST_LIT = ['ada', 'tunde', 'wanjiru', 'paolo'];

/** The hero wall: windows light one after another on the first visit, then it's yours to tap. */
function HeroWall() {
  const [room, setRoom] = useState(ROOM);
  useEffect(() => {
    if (reduce()) { setRoom((r) => r.map((f) => ({ ...f, lit: FIRST_LIT.includes(f.id) }))); return; }
    const ts = FIRST_LIT.map((id, i) => setTimeout(() => setRoom((r) => r.map((f) => (f.id === id ? { ...f, lit: true } : f))), 450 + i * 140));
    return () => ts.forEach(clearTimeout);
  }, []);
  const saved = room.filter((f) => f.lit).length;
  const tilt = useTilt<HTMLDivElement>(3);
  return (
    <div className="hero-wall">
      <span className="hero-sun"><Sun size={130} /></span>
      <div className="facade" ref={tilt}>
        <span className="facade-gloss" aria-hidden="true" />
        <span className="facade-sun" aria-hidden="true" />
        <Wall friends={room} size="lg" onPress={(id) => setRoom((r) => r.map((f) => (f.id === id ? { ...f, lit: !f.lit } : f)))} />
      </div>
      <p className="hero-wall-line" aria-live="polite">
        <b><Odometer value={String(saved)} /> of 6</b> have saved this payday. Tap a window.
      </p>
    </div>
  );
}

/* ---- Real people (Unsplash photos, credited; captions give each photo's recorded location only) --- */
type Credit = { by: string; by_url: string; page: string; loc: string };
const CR = CREDITS as Record<string, Credit>;
const place = (loc: string) => { const parts = loc.split(',').map((x) => x.trim()).filter(Boolean); return parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1].replace('México', 'Mexico')}` : parts[0] ?? ''; };
function Tile({ id }: { id: string }) {
  const c = CR[id];
  return (
    <figure className="tile">
      <img src={`photos/${id}-t.webp`} alt="" loading="lazy" draggable={false} />
      {c.loc && <figcaption><span className="tile-loc">{place(c.loc)}</span></figcaption>}
    </figure>
  );
}
const ROW = ['O8SpYxOFnK8', '0ITvgXAU5Oo', '7CWzZ_3Z04s', 'joqWSI9u_XM', 'cvh7covtt-A', 'jpqyfK7GB4w', 'WUG0QcXVh0k'];
/** One slow row of real people. Each photo rests softened; the one you point at (or, on a phone, the
 * one passing the middle of the screen) comes into full colour and focus. */
function People() {
  const [ref, on] = useInView<HTMLElement>(false, '0px');
  const track = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!on || !matchMedia('(hover: none)').matches) return;
    const t = setInterval(() => {
      const tiles = track.current?.querySelectorAll<HTMLElement>('.tile'); if (!tiles) return;
      const mid = innerWidth / 2; let best: HTMLElement | null = null; let d = Infinity;
      tiles.forEach((el) => { const r = el.getBoundingClientRect(); const x = Math.abs(r.left + r.width / 2 - mid); if (x < d) { d = x; best = el; } });
      tiles.forEach((el) => el.classList.toggle('hi', el === best));
    }, 250);
    return () => clearInterval(t);
  }, [on]);
  return (
    <section ref={ref} className={`people t-day ${on ? 'playing' : ''}`} aria-labelledby="people-h">
      <div className="people-head">
        <h2 id="people-h">Payday feels the same <Sweep>everywhere</Sweep></h2>
        <p>A little put away, a few friends who notice, and something to look forward to on Friday.</p>
      </div>
      <div className="strip">
        <div className="strip-track" ref={track}>{[...ROW, ...ROW].map((id, i) => <Tile key={i} id={id} />)}</div>
      </div>
    </section>
  );
}

/* ---- A little, every payday: a hand pours into a jar; the amounts tick up as you scroll ---------- */
function JarBand() {
  const ref = useScrollVar<HTMLElement>('--jp');
  const [cref, on] = useInView<HTMLDivElement>(true, '0px 0px -20% 0px');
  return (
    <section ref={ref} className="jarband" aria-labelledby="jar-h">
      <div className="jarband-photo" aria-hidden="true"><img src="photos/jar-pour.webp" alt="" loading="lazy" /></div>
      <div className="jarband-copy" ref={cref}>
        <h2 id="jar-h">A little, <Sweep>every payday</Sweep></h2>
        <p>Five here, ten there. It goes into your own vault, it earns while it waits, and it's yours to take out any time.</p>
        <div className={`jar-chips ${on ? 'in' : ''}`}>
          <span className="jar-chip"><small>This payday</small><b>+<Odometer value={money(weeklyDefault)} /></b></span>
          <span className="jar-chip"><small>Saved so far</small><b><Odometer value={money(weeklyDefault * 9)} /></b></span>
          <span className="jar-chip jar-chip-k"><small>Streak</small><b><Odometer value="4" /> weeks</b></span>
        </div>
      </div>
    </section>
  );
}

/* ---- Every kernel counts: the sack of cashews at night; moonlight passes over it as you scroll ---- */
function KernelBand() {
  const ref = useScrollVar<HTMLElement>('--kp');
  return (
    <section ref={ref} className="kernelband" aria-labelledby="kernel-h">
      <div className="kernelband-photo" aria-hidden="true"><img src="photos/cashew-sack.webp" alt="" loading="lazy" /><span className="kb-light" /></div>
      <div className="kernelband-copy">
        <h2 id="kernel-h">Every kernel counts</h2>
        <p>Each week you save in a row adds a kernel to your streak, and each kernel is a chance on Friday, up to four. Nobody can buy more.</p>
        <KernelRow filled={4} total={4} label="Four kernels, four chances" />
      </div>
    </section>
  );
}

/** Photographers, credited once, in the footer. */
function PhotoCredits() {
  const seen = new Set<string>();
  const list = Object.values(CR).filter((c) => (seen.has(c.by) ? false : (seen.add(c.by), true)));
  return (
    <details className="photo-credits">
      <summary>Photo credits</summary>
      <p>Photos from <a href="https://unsplash.com/?utm_source=kashu&utm_medium=referral" target="_blank" rel="noreferrer">Unsplash</a> by {list.map((c, i) => <span key={c.by}><a href={c.by_url} target="_blank" rel="noreferrer">{c.by}</a>{i < list.length - 2 ? ', ' : i === list.length - 2 ? ' and ' : '.'}</span>)} The moon is from NASA's Lunar Reconnaissance Orbiter.</p>
    </details>
  );
}

/** The one scroll-driven moment: the same wall through a week. */
const WEEK = [
  { key: 'payday', kicker: 'Payday', title: 'Put a little away', body: 'Everyone in the room saves what they chose. Your window lights up. Your friends see the light, never the amount.' },
  { key: 'streak', kicker: 'Every week', title: 'Keep your streak', body: 'Each week in a row adds a kernel to your streak, and more chances in Friday\'s draw. Up to four.' },
  { key: 'friday', kicker: 'Friday, 8pm', title: 'Draw night', body: 'The interest the room earned that week becomes one prize. A fair draw picks who gets it. Everyone keeps every bit of their savings.' },
] as const;

function WeekStory() {
  const [step, setStep] = useState(0);
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  const secRef = useScrollVar<HTMLElement>('--wp');
  const go = (i: number) => refs.current[i]?.scrollIntoView({ behavior: reduce() ? 'auto' : 'smooth', block: 'center' });
  // the step is whichever step's middle is nearest the middle of the screen; the steps sit in their own
  // column, so changing the step never moves them (the old observer could flip back and forth forever)
  useEffect(() => {
    let raf = 0;
    const pick = () => {
      raf = 0; const mid = (document.documentElement.clientHeight || innerHeight) / 2; let best = 0, d = Infinity;
      refs.current.forEach((el, i) => { if (!el) return; const r = el.getBoundingClientRect(); const x = Math.abs(r.top + r.height / 2 - mid); if (x < d) { d = x; best = i; } });
      setStep((s0) => (s0 === best ? s0 : best));
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(pick); };
    pick(); addEventListener('scroll', on, { passive: true }); addEventListener('resize', on);
    return () => { removeEventListener('scroll', on); removeEventListener('resize', on); cancelAnimationFrame(raf); };
  }, []);
  const lit = step === 0 ? ['ada', 'tunde', 'you'] : ['ada', 'tunde', 'kemi', 'wanjiru', 'you', 'paolo'];
  const friends = ROOM.map((f) => ({ ...f, lit: lit.includes(f.id), glow: step === 2 && f.id === 'tunde' }));
  return (
    <section ref={secRef} className={`week t-day is-${WEEK[step].key}`} aria-labelledby="week-h">
      <div className="week-head">
        <Label n="01">How a week goes</Label>
        <h2 id="week-h" className="sr-only">How a week goes</h2>
        <div className="week-tabs" role="group" aria-label="Jump to a day">
          {WEEK.map((w, i) => <button key={w.key} type="button" className={i === step ? 'on' : ''} aria-pressed={i === step} onClick={() => go(i)}>{w.kicker}</button>)}
          <span className="week-rail" aria-hidden="true"><span /></span>
        </div>
      </div>
      <div className="week-stage" aria-hidden="true">
        <div className="week-sky">
          <span className="week-body">{step === 2 ? <Moon size={64} /> : <Sun size={52} />}</span>
        </div>
        <Wall friends={friends} size="md" />
        <div className="week-streak">
          <KernelRow filled={step === 0 ? 2 : 3} total={6} label="" />
          <span>{step === 0 ? '2 weeks in a row' : step === 1 ? '3 weeks in a row · 3 chances' : 'Tunde won this week'}</span>
        </div>
      </div>
      <div className="week-steps">
        {WEEK.map((w, i) => (
          <div key={w.key} className={`week-step ${i === step ? 'on' : ''}`} data-i={i} ref={(el) => { refs.current[i] = el; }}>
            <span className="kicker">{w.kicker}</span>
            <h3>{w.title}</h3>
            <p>{w.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Draw night, played on the page: a light travels the lit windows and rests. */
function DrawDemo() {
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [at, setAt] = useState<string | null>(null);
  const [calm, setCalm] = useState(false);
  const winner = useRef('wanjiru');
  const lit = ['ada', 'tunde', 'wanjiru', 'you', 'paolo'];
  const run = () => {
    const pick = lit[Math.floor(Math.random() * lit.length)];
    winner.current = pick;
    if (calm || reduce()) { setAt(pick); setPhase('done'); return; }
    setPhase('running');
    const path = [...lit, ...lit, ...lit.slice(0, lit.indexOf(pick) + 1)];
    path.forEach((id, i) => setTimeout(() => { setAt(id); if (i === path.length - 1) setPhase('done'); }, 90 * i + Math.pow(i / path.length, 3) * 900));
  };
  const friends = ROOM.map((f) => ({ ...f, lit: lit.includes(f.id) }));
  const name = (id: string) => (id === 'you' ? 'You' : ROOM.find((f) => f.id === id)?.name);
  return (
    <section className="drawband t-night" aria-labelledby="draw-h">
      <Stars />
      <div className="drawband-inner">
        <div className="drawband-copy">
          <Label n="06" tone="on-dark">Every Friday, 8pm</Label>
          <h2 id="draw-h">Draw night</h2>
          <p>The week's interest, plus a Friday bonus from sponsors, is the prize. Nothing is paid to enter, and the draw never touches anyone's savings.</p>
          <div className="drawband-actions">
            <button type="button" className="btn btn-kernel" onClick={run} disabled={phase === 'running'}>
              {phase === 'done' ? 'Draw again' : 'Try a draw'}
            </button>
            <label className="calm"><input type="checkbox" checked={calm} onChange={(e) => setCalm(e.target.checked)} /> Calm draw</label>
          </div>
          <p className="drawband-result" aria-live="polite">
            {phase === 'done' && at && <>{name(at) === 'You' ? <>It's you! <Odometer value={money(PRIZE)} />. </> : <>{name(at)} gets this week's <Odometer value={money(PRIZE)} />. </>}Everyone's savings are untouched.</>}
          </p>
        </div>
        <div className="drawband-stage" aria-hidden="true">
          <Moon size={130} />
          <Wall friends={friends} size="sm" highlightId={at ?? undefined} />
        </div>
      </div>
    </section>
  );
}

function TwoViews() {
  return (
    <section className="views t-golden2" aria-labelledby="views-h">
      <div className="section-head">
        <Label n="04">Private by default</Label>
        <h2 id="views-h">Your friends see the light. <Sweep>Never the amount.</Sweep></h2>
      </div>
      <div className="views-row">
        <div className="view-col">
          <Phone device="iphone" label="You">
          <div className="phone-screen">
            <span className="ph-kicker">My savings · only you</span>
            <span className="ph-amount display">{money(local(18000))}</span>
            <div className="ph-row"><span>Interest earned</span><b>{money(local(412))}</b></div>
            <div className="ph-row"><span>Prizes won</span><b>{money(PRIZE)}</b></div>
            <KernelRow filled={4} total={6} />
          </div>
          </Phone>
        </div>
        <div className="view-col">
          <Phone device="seeker" label="Your friend Ada">
          <div className="phone-screen phone-friend">
            <span className="ph-kicker">Payday crew</span>
            <Wall friends={[{ id: 'you', name: 'Chidi', lit: true, streak: 4, pattern: 'panel' }]} size="md" cols={1} />
            <span className="ph-note">Chidi saved this payday · 4 weeks in a row</span>
            <span className="ph-lock">No amounts. Ever.</span>
          </div>
          </Phone>
        </div>
      </div>
    </section>
  );
}

/* ---- In your pocket: the app on a real iPhone and a Seeker; tap a screen name or let it play -------- */
const SCREENS = [
  { k: 'room', t: 'Room', line: 'Who has saved this payday. Lights, never amounts.' },
  { k: 'save', t: 'Save', line: 'Pick an amount and hold to save. Done in seconds.' },
  { k: 'draw', t: 'Draw night', line: 'Friday at 8, the room watches the draw together.' },
  { k: 'savings', t: 'My savings', line: 'Hidden until you hold it. Yours to take out any time.' },
] as const;
function Pocket() {
  const [i, setI] = useState(0);
  const [touched, setTouched] = useState(false);
  const [ref, on] = useInView<HTMLElement>(false, '0px');
  const pref = useScrollVar<HTMLDivElement>('--pp');
  useEffect(() => {
    if (!on || touched || reduce()) return;
    const t = setInterval(() => setI((x) => (x + 1) % SCREENS.length), 3600);
    return () => clearInterval(t);
  }, [on, touched]);
  const pick = (j: number) => { setTouched(true); setI(j); };
  const night = SCREENS[i].k === 'draw';
  return (
    <section ref={ref} className="pocket t-afternoon" aria-labelledby="pocket-h">
      <div className="pocket-inner">
        <div className="pocket-copy">
          <Label n="02">In your pocket</Label>
          <h2 id="pocket-h">The whole room, <Sweep>on your phone</Sweep></h2>
          <p>Made for the phone in your hand: Seeker, iPhone and Android.</p>
          <div className="pocket-tabs" role="tablist" aria-label="Screens">
            {SCREENS.map((x, j) => (
              <button key={x.k} type="button" role="tab" aria-selected={j === i} className={j === i ? 'on' : ''} onClick={() => pick(j)}>
                <span className="pt-t">{x.t}</span><span className="pt-l">{x.line}</span>
                {j === i && !touched && on && !reduce() && <span key={i} className="pt-timer" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
        <div className="pocket-stage" ref={pref}>
          <Phone device="seeker" className="ps-seeker" src={SCREENS.map((x) => `screens/seeker-${x.k}.webp`)} index={i} dark={night} />
          <Phone device="iphone" className="ps-iphone" src={SCREENS.map((x) => `screens/iphone-${x.k}.webp`)} index={i} dark={night} />
        </div>
      </div>
    </section>
  );
}

/* ---- Kept safe: the vault locks as you read; four promises in plain words --------------------- */
function MiniProof() {
  return (
    <svg viewBox="0 0 120 80" className="mini mini-proof" aria-hidden="true">
      <rect x="6" y="14" width="108" height="52" rx="8" className="m-card" />
      <text x="16" y="36" className="m-hex">7f3a 9c1e b2d4</text>
      <text x="16" y="54" className="m-hex m-hex2">e8 → Ada</text>
      <circle cx="98" cy="50" r="9" className="m-ok" /><path d="M94 50l3 3 6-6" className="m-okmark" />
    </svg>
  );
}
function MiniLimit() {
  return (
    <svg viewBox="0 0 120 80" className="mini mini-limit" aria-hidden="true">
      <rect x="10" y="34" width="100" height="14" rx="7" className="m-track" />
      <rect x="10" y="34" width="70" height="14" rx="7" className="m-fill" />
      <path d="M82 24v34" className="m-cap" /><text x="82" y="18" className="m-captext">cap</text>
    </svg>
  );
}
const PROMISES = [
  { t: 'Your own vault.', b: 'Only you can take money out, and only to yourself. Not us, not your friends.', m: null },
  { t: 'The draw never touches your savings.', b: 'The prize comes from interest and sponsors. Savings never go into it.', m: <img className="mini-img" src="objects/jar-cut.webp" alt="" /> },
  { t: 'A draw anyone can check.', b: 'The winner comes from verifiable randomness. Every result links to its proof.', m: <MiniProof /> },
  { t: 'Small, careful limits.', b: 'During the beta, up to 50 US dollars per person and 5,000 in total, so we grow safely.', m: <MiniLimit /> },
];
function Trust() {
  const [locked, setLocked] = useState(false);
  // locks past 62% and only unlocks again below 55%, so it can't flicker at the edge
  const ref = useScrollVar<HTMLElement>('--vp', (p) => setLocked((l) => (l ? p > 0.55 : p > 0.62)));
  const [lref, on] = useInView<HTMLOListElement>(false, '0px');
  return (
    <section ref={ref} className="trust t-golden" aria-labelledby="trust-h">
      <div className="trust-inner">
        <div className="vault-stage" aria-hidden="true">
          <div className={`vault ${locked ? 'is-locked' : ''}`}>
            <img src="objects/vault-body.webp" alt="" />
            <img className="vault-dial" src="objects/vault-dial.webp" alt="" />
            <img className="vault-handle" src="objects/vault-handle.webp" alt="" />
          </div>
          <span className={`vault-state ${locked ? 'on' : ''}`}>{locked ? 'Locked. Only you hold the key.' : 'Your vault'}</span>
        </div>
        <div className="trust-copy">
          <div className="section-head">
            <Label n="03">Your money stays yours</Label>
            <h2 id="trust-h">Kept safe, in <Sweep tone="leaf">plain words</Sweep></h2>
          </div>
          <ol ref={lref} className={`trust-list ${on ? 'playing' : ''}`}>
            {PROMISES.map((x, i) => (
              <Reveal as="li" key={x.t} i={i}>
                <span className="trust-n display">0{i + 1}</span>
                <span className="trust-text"><b>{x.t}</b> {x.b}</span>
                {x.m}
              </Reveal>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ---- Sunset: the afternoon goes down into Friday night ----------------------------------------- */
function SunsetBand() {
  const ref = useScrollVar<HTMLElement>('--sp');
  return (
    <section ref={ref} className="sunset" aria-hidden="true">
      <div className="sunset-sticky">
        <span className="sunset-sun"><Sun size={150} /></span>
        <span className="sunset-horizon" />
        <span className="sunset-line display">Friday, 8pm</span>
      </div>
    </section>
  );
}

/* ---- Stars, for the night sections ------------------------------------------------------------- */
const STARS = Array.from({ length: 46 }, (_, i) => ({ x: (i * 73.13) % 100, y: (i * 37.7) % 100, s: 1 + ((i * 7) % 3) * 0.6, d: (i * 0.37) % 4 }));
function Stars() {
  return <span className="stars" aria-hidden="true">{STARS.map((st, i) => <i key={i} style={{ left: `${st.x}%`, top: `${st.y}%`, width: st.s, height: st.s, animationDelay: `${st.d}s` }} />)}</span>;
}

/* ---- Play a month: tap weeks to save or skip, and watch the streak and Friday's chances ---------- */
function PlayMonth() {
  const [weeks, setWeeks] = useState([true, true, false, true, true, true]);
  let streak = 0; for (let i = weeks.length - 1; i >= 0 && weeks[i]; i--) streak++;
  const chances = weeks[weeks.length - 1] ? Math.min(4, Math.max(1, streak)) : 0;
  const saved = weeks.filter(Boolean).length * weeklyDefault;
  const skippedLast = weeks.some((w, i) => !w && i < weeks.length - 1);
  return (
    <section className="play t-sunset" aria-labelledby="play-h">
      <div className="play-inner">
        <div className="play-copy">
          <Label n="05">Try it</Label>
          <h2 id="play-h">Play a month</h2>
          <p>Tap a week to save or skip it. Each week in a row adds a chance in Friday's draw, up to four.</p>
        </div>
        <div className="play-board">
          <div className="play-weeks" role="group" aria-label="Six weeks">
            {weeks.map((w, i) => (
              <button key={i} type="button" className={`pw ${w ? 'on' : ''}`} aria-pressed={w}
                onClick={() => setWeeks((ws) => ws.map((x, j) => (j === i ? !x : x)))}>
                <img src={i % 2 ? 'objects/kernel-b.webp' : 'objects/kernel-a.webp'} alt="" className="pw-k" draggable={false} />
                <span>Week {i + 1}</span>
                <small>{w ? 'Saved' : 'Skipped'}</small>
              </button>
            ))}
          </div>
          <dl className="play-out" aria-live="polite">
            <div><dt>Streak</dt><dd><Odometer value={String(streak)} /> <span>in a row</span></dd></div>
            <div><dt>Chances this Friday</dt><dd className="kern"><Odometer value={String(chances)} /> <span>of 4</span></dd></div>
            <div><dt>Saved, all yours</dt><dd><Odometer value={money(saved)} /></dd></div>
          </dl>
          <p className="play-note">{!weeks[weeks.length - 1] ? 'Skip this week and you sit out Friday. Your savings stay put.' : skippedLast ? 'A skipped week starts the streak again. It never touches your savings.' : 'A full run. Four chances is the most anyone gets, so nobody can buy the draw.'}</p>
        </div>
      </div>
    </section>
  );
}

/* ---- Roots: the same habit, by its local name -------------------------------------------------- */
const CIRCLES = [
  { city: 'Nigeria', name: 'Ajo', photo: 'O8SpYxOFnK8', line: 'Friends and traders pay into one pot, and each takes the whole pot in turn.' },
  { city: 'Kenya', name: 'Chama', photo: 'ASE693afayc', line: 'A group saves together every month, and often invests as one.' },
  { city: 'Philippines', name: 'Paluwagan', photo: '-5mKWmLOa3k', line: 'Co-workers chip in each payday and take turns receiving it all.' },
  { city: 'Malaysia', name: 'Kutu', photo: 'BP7VvW_0-z4', line: 'Neighbours and colleagues run a monthly pot, with a set order.' },
  { city: 'Ghana', name: 'Susu', photo: '-V97fx72wd4', line: 'A collector takes small daily savings and gives them back at month end.' },
  { city: 'Mexico', name: 'Tanda', photo: '7salZQVglhg', line: 'Family and friends pool money and draw turns for the payout.' },
];
function RootsMap() {
  const [i, setI] = useState(0);
  const c = CIRCLES[i];
  return (
    <div className="roots-pick">
      <div className="roots-chips" role="group" aria-label="Pick a country">
        {CIRCLES.map((x, j) => <button key={x.city} type="button" className={j === i ? 'on' : ''} aria-pressed={j === i} onClick={() => setI(j)}>{x.city}</button>)}
      </div>
      <div className="roots-show">
        <figure className="roots-photo" key={c.photo}>
          <img src={`photos/${c.photo}-w.webp`} alt="" />
          <figcaption><span className="tile-loc">{place(CR[c.photo].loc)}</span></figcaption>
        </figure>
        <p className="roots-name" aria-live="polite"><span key={c.name} className="display">{c.name}</span><span key={c.line} className="roots-line">{c.line}</span></p>
      </div>
    </div>
  );
}

const FAQ = [
  ['Is this gambling?', 'It\'s built not to be. You never pay to enter, and the draw never touches your savings. The prize is the interest your room earned that week, plus a Friday bonus from sponsors. If you don\'t win, your savings are exactly where they were.'],
  ['Where does the interest come from?', 'Your savings are lent on Jupiter Lend, one of the largest lending markets on Solana, which has paid around 4 to 6% a year lately. Kashu keeps 10% of that interest to run the service (that\'s the most it can ever take, and we plan to lower it), and the rest goes to your room\'s prize. If you\'d rather keep all your interest, skip the prize and Kashu takes nothing. Lending always carries some risk, which is why the beta keeps amounts small.'],
  ['What if I need my money?', 'Take it out any time, all of it. The only thing that changes is your streak, and we tell you that before you confirm.'],
  ['Who holds my money?', 'You do. Your savings sit in your own vault that only you can withdraw from. We can\'t move it, and neither can your friends.'],
  ['What does it cost?', 'Nothing to join a room, save, or take your money out. If your room plays for the Friday prize, Kashu keeps 10% of the interest that goes into it. During the beta there are limits on how much each person can save, so we can grow carefully.'],
  ['Do my friends see how much I save?', 'Not in Kashu. They see that your light is on this payday and how many weeks in a row you\'ve saved, never an amount. Your room itself is private. Your vault is a Solana account, so like any account it can be looked up by someone who has your wallet address; fully private balances are on our roadmap.'],
];

export function Landing() {
  return (
    <div className="landing">
      <header className="lp-top">
        <a href="#top" aria-label="Kashu home"><Wordmark height={34} /></a>
        <nav aria-label="Main">
          <a href="#how" className="lp-link">How it works</a>
          <a href="#app" className="btn btn-primary btn-sm">Open Kashu</a>
        </nav>
      </header>

      <main>
        <section className="hero t-morning" aria-labelledby="hero-h">
          <div className="hero-copy">
            <h1 id="hero-h">Save with your people. <span className="hero-accent">Win on <Sweep>Fridays.</Sweep></span></h1>
            <p className="lede">Put a little away every payday with your friends. Your money stays yours. The interest becomes a prize for someone in your room.</p>
            <div className="hero-actions">
              <a href="#app-start" className="btn btn-primary">Start a room</a>
              <a href="#how" className="btn btn-ghost">See how a week goes</a>
            </div>
            <p className="promise"><Mark size={22} /> The draw never touches your savings.</p>
          </div>
          <HeroWall />
        </section>

        <People />
        <JarBand />
        <div id="how" />
        <WeekStory />
        <Pocket />
        <Trust />
        <TwoViews />
        <PlayMonth />
        <SunsetBand />
        <DrawDemo />
        <KernelBand />

        <section className="roots t-night2" aria-labelledby="roots-h">
          <Stars />
          <Label n="07" tone="on-dark">Where it comes from</Label>
          <h2 id="roots-h">You already do this</h2>
          <RootsMap />
          <p>Friends saving together and taking turns is one of the oldest money habits there is. Kashu keeps the friends and the habit, and adds a weekly prize nobody has to pay for.</p>
        </section>

        <section className="faq t-night2" aria-labelledby="faq-h">
          <Label n="08" tone="on-dark">Fair questions</Label>
          <h2 id="faq-h">Questions people ask</h2>
          {FAQ.map(([q, a], i) => (
            <Reveal key={q} as="details" i={i}><summary>{q}</summary><p>{a}</p></Reveal>
          ))}
        </section>

        <section className="final t-dawn" aria-labelledby="final-h">
          <Stars />
          <span className="dawn-sun"><Sun size={170} /></span>
          <SplitFlap word="PAYDAY" className="final-flap" />
          <h2 id="final-h">Start a room this payday</h2>
          <p>Invite two friends and your first draw night is on.</p>
          <a href="#app-start" className="btn btn-kernel">Start a room</a>
        </section>
      </main>

      <div className="lp-foot-wrap"><footer className="lp-foot">
        <Wordmark height={26} />
        <PoweredBy />
        <span className="foot-links"><a href="#app-advanced">How it works underneath</a><span>{MAINNET ? 'Invite-only beta' : 'Beta on devnet'} · <a href="#terms">Terms</a> · <a href="#privacy">Privacy</a> · <a href="#draw-rules">Draw rules</a></span><PhotoCredits /></span>
      </footer></div>
    </div>
  );
}
