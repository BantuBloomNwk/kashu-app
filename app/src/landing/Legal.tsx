import { MAINNET } from '../config.ts';

// Kashu's terms, privacy and draw rules, in plain words. Drafts for the invite-only beta: counsel reviews them before
// Kashu opens to everyone, and they say so.
const DRAFT = 'Beta draft, under review by counsel before Kashu opens to everyone. Last updated 23 November 2026.';

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="legal">
      <a className="legal-back" href="#top">Kashu</a>
      <h1>{title}</h1>
      <p className="legal-draft">{DRAFT}</p>
      {children}
      <nav className="legal-nav"><a href="#terms">Terms</a> · <a href="#privacy">Privacy</a> · <a href="#draw-rules">Draw rules</a> · <a href="#security">Security</a></nav>
    </main>
  );
}

export function DrawRules() {
  return (
    <Page title="Draw rules">
      <h2>Nothing to pay, nothing to lose</h2>
      <p>Each week, each room's draw picks one saver to receive the room's prize. Nobody pays to enter. No part of anyone's savings goes into the prize, ever: the vault program on Solana won't allow it. If you don't win, your savings are exactly where they were.</p>
      <h2>Where the prize comes from</h2>
      <p>Only from the interest the room's savings earned that week on Jupiter Lend (after Kashu's share of that interest, at most 10%), plus any bonus a sponsor adds. If the interest was small, the prize is small.</p>
      <h2>Who is in the draw</h2>
      <p>Every member of the room who saved that week. Saving in a row earns more tickets, up to four. A ticket is never bought: you can't get more by paying.</p>
      <h2>How the winner is picked</h2>
      <p>A random number from MagicBlock's VRF, which comes with a proof anyone can check, picks the winning ticket. The steps and their receipts are in each room under Behind the scenes.</p>
      <h2>Paying out</h2>
      <p>The prize goes straight into the winner's own vault, as their savings, usually within minutes of the draw.</p>
      <h2>Who may take part</h2>
      <p>During the beta: people invited by a member, 18 or older, where taking part in a free prize draw is allowed. {MAINNET ? 'Savings are capped at $50 per person and $5,000 in all while the beta runs.' : 'This preview runs on test money.'}</p>
    </Page>
  );
}

export function Privacy() {
  return (
    <Page title="Privacy">
      <h2>What anyone can see</h2>
      <p>Kashu runs on Solana, a public network. Your Kashutag, your profile photo, the rooms you belong to, and money moving into or out of your wallet, vault or private pocket can be looked up by anyone who knows your wallet's address. Your savings vault's balance is one of those things.</p>
      <h2>What only your room can see</h2>
      <p>Inside a room (saves, streaks, tickets, cheers), everything lives on MagicBlock's private rollup, readable only by the room's members' phones.</p>
      <h2>What only you can see</h2>
      <p>Your private pocket's balance, and who you pay from it, sit on that private rollup too, readable only by your pocket's key, which comes from your passkey.</p>
      <h2>What Kashu keeps</h2>
      <p>No names, emails or phone numbers. Kashu's servers keep your profile photo (resized, with location data removed), notification addresses for phones that asked to hear about wins, and short-lived technical logs. Chats with the agent are not stored; the AI runs in sealed hardware that Kashu checks before every chat.</p>
      <h2>Your passkey</h2>
      <p>Stays on your device and in your password manager. Kashu never sees it.</p>
    </Page>
  );
}

export function Terms() {
  return (
    <Page title="Terms">
      <h2>Your money is yours</h2>
      <p>Kashu doesn't hold your money. Your savings sit in your own vault on Solana, which only you can take money out of, with your passkey. Kashu pays the network fees for most actions; it can't move your savings.</p>
      <h2>What Kashu charges</h2>
      <p>Up to 10% of the interest your savings earn, if you join your room's prize (you can keep all your interest instead). One cent each time your agent runs a chore. Nothing else.</p>
      <h2>Risks</h2>
      <p>Interest comes from lending on Jupiter Lend and isn't guaranteed. Kashu's programs are new and are being audited; that's why the beta is invite-only and capped. Software can have bugs. Don't save money you can't do without.</p>
      <h2>Not advice</h2>
      <p>Kashu doesn't give financial advice. The plans and chores are yours to choose.</p>
      <h2>The beta</h2>
      <p>Features may change. You can take everything out at any time.</p>
    </Page>
  );
}

export function Security() {
  return (
    <Page title="Security">
      <h2>Found a problem? Tell us privately</h2>
      <p>Report it through GitHub's private vulnerability reporting on Kashu's repository (github.com/BantuBloomNwk/kashu-app, under Security). Please don't post it publicly or test it on other people's money. We reply within three days and tell you what we did about it.</p>
      <h2>What's in scope</h2>
      <p>Kashu's vault and rooms programs on Solana, the relay and keeper that pay fees and run each week, the agent service, and this app. Bugs in Solana, MagicBlock, Jupiter, Swig or NEAR AI belong to those teams, but tell us too if they put Kashu savers at risk.</p>
      <h2>Safe harbour</h2>
      <p>If you act in good faith, stay within your own accounts, and give us time to fix things before telling anyone, we won't take action against you.</p>
      <h2>What protects savers today</h2>
      <p>Savings sit in each saver's own vault, which only their passkey can empty. The beta is invite-only and capped by the programs themselves at $50 a saver and $5,000 in all. On mainnet, before the beta opens, upgrading the programs moves to a multisig that needs two of three separately held keys. An external audit comes before Kashu opens wider. There's no bug bounty yet; we'll say so here when there is.</p>
    </Page>
  );
}
