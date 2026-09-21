import type { ReactNode } from "react";

export const docPages = ["rules", "cli", "agent"] as const;
export type DocPage = (typeof docPages)[number];

export function isDocPage(value: string | undefined): value is DocPage {
  return docPages.some((page) => page === value);
}

const titles: Record<DocPage, string> = {
  rules: "Rules",
  cli: "CLI",
  agent: "Agent",
};

export function DocsApp({ page }: { page: DocPage }) {
  return (
    <div className="docs-shell">
      <header className="docs-header">
        <a className="wordmark-static" href="/" aria-label="Cabo game">CABO</a>
        <nav aria-label="Documentation">
          {docPages.map((item) => (
            <a key={item} href={`/docs/${item}/`} aria-current={item === page ? "page" : undefined}>
              {titles[item]}
            </a>
          ))}
        </nav>
        <a className="docs-play-link" href="/">Play</a>
      </header>
      <main className="docs-main">
        <aside className="docs-aside">
          <p className="eyebrow">Cabo documentation</p>
          <nav aria-label="On this page">
            {sectionLinks[page].map((section) => <a key={section.id} href={`#${section.id}`}>{section.label}</a>)}
          </nav>
        </aside>
        {page === "rules" && <RulesPage />}
        {page === "cli" && <CliPage />}
        {page === "agent" && <AgentPage />}
      </main>
      <footer className="docs-footer">
        <span>Cabo is a server-authoritative online card table.</span>
        <a href="https://github.com/allenhooray/cabo-game">Source on GitHub</a>
      </footer>
    </div>
  );
}

const sectionLinks: Record<DocPage, Array<{ id: string; label: string }>> = {
  rules: [
    { id: "goal", label: "Goal and setup" },
    { id: "turns", label: "Taking a turn" },
    { id: "powers", label: "Card powers" },
    { id: "cabo", label: "Calling Cabo" },
    { id: "connections", label: "Connections" },
  ],
  cli: [
    { id: "install", label: "Install and start" },
    { id: "connection", label: "Connection commands" },
    { id: "lobby", label: "Lobby commands" },
    { id: "game", label: "Game commands" },
    { id: "interaction", label: "Interaction notes" },
  ],
  agent: [
    { id: "start-agent", label: "Start an Agent" },
    { id: "transport", label: "Process contract" },
    { id: "loop", label: "Supervisor loop" },
    { id: "state", label: "State and recovery" },
    { id: "lifecycle", label: "Sessions and shutdown" },
  ],
};

function Article(props: { eyebrow: string; title: string; lede: string; children: ReactNode }) {
  return (
    <article className="docs-article">
      <header className="docs-intro">
        <p className="eyebrow">{props.eyebrow}</p>
        <h1>{props.title}</h1>
        <p>{props.lede}</p>
      </header>
      {props.children}
    </article>
  );
}

function Section(props: { id: string; title: string; children: ReactNode }) {
  return <section id={props.id} className="docs-section"><h2>{props.title}</h2>{props.children}</section>;
}

function CodeBlock({ children }: { children: string }) {
  return <pre><code>{children}</code></pre>;
}

function RulesPage() {
  return (
    <Article eyebrow="Rules" title="Keep the lowest hand." lede="Cabo is a memory game for two to five players. Learn just enough, remember what matters, and end the round at the right moment.">
      <Section id="goal" title="Goal and setup">
        <p>Finish the match with the lowest total score. Each player receives four face-down cards and privately sees positions 1 and 2 once at the start of every round. After that, cards stay hidden unless a power reveals one.</p>
        <p>A through Q score their numeric rank: A is 1, J is 11, and Q is 12. The two Kings are worth 13 each. Both Jokers are worth 0.</p>
        <div className="docs-callout"><strong>Memory is private.</strong><span>The table remembers only cards you have legitimately seen. Other players never receive that knowledge.</span></div>
      </Section>
      <Section id="turns" title="Taking a turn">
        <ol>
          <li>At the start of your turn, draw from the deck, take the top discard, or call Cabo.</li>
          <li>A deck card is shown only to you. Replace one to four cards with it, or discard the drawn card.</li>
          <li>Taking the top discard must be followed by replacing one to four cards; it cannot activate a power.</li>
          <li>When replacing multiple cards, all selected cards must share a rank. They are discarded and the drawn card occupies one selected position.</li>
          <li>If selected cards do not match, they remain and are revealed. The drawn card is added to either end; selecting three or four wrong cards also adds one unseen penalty card.</li>
          <li>Your turn ends after the replacement or after resolving—or skipping—an available card power.</li>
        </ol>
        <p>Only a card drawn from the deck and then discarded can activate a power. A card taken from the discard pile never activates its power.</p>
      </Section>
      <Section id="powers" title="Card powers">
        <div className="docs-table-wrap"><table><thead><tr><th>Ranks</th><th>Power</th></tr></thead><tbody>
          <tr><td>7–8</td><td>Privately look at one of your own positions.</td></tr>
          <tr><td>9–10</td><td>Privately look at one position belonging to another active player.</td></tr>
          <tr><td>J–Q</td><td>Blindly swap one of your positions with the same position of another active player.</td></tr>
        </tbody></table></div>
        <p>You may skip a power. Swapped cards are not revealed to either player.</p>
      </Section>
      <Section id="cabo" title="Calling Cabo and scoring">
        <p>You may call Cabo only at the beginning of your turn. Every other active player then receives one final turn; the caller does not.</p>
        <ul>
          <li>If the caller has a strictly lower hand than every other player, the caller scores 0.</li>
          <li>If anyone ties or beats the caller, the caller scores their hand value plus a 5-point penalty.</li>
          <li>Every other player adds their hand value to their total.</li>
        </ul>
        <p>When any active player reaches the room’s target score, the match ends. The active player—or tied players—with the lowest total wins.</p>
        <p><strong>Shooting the Moon:</strong> a player ending the round with exactly two Queens and both Kings scores 0, while every other active player scores half the target score. This overrides normal Cabo scoring.</p>
      </Section>
      <Section id="connections" title="Connections and leaving">
        <p>A disconnected seat is reserved for 60 seconds so the player can reconnect. If the grace period expires, that player forfeits and the remaining players continue.</p>
        <p>Choosing to leave during an active match is an immediate forfeit. Do not use Leave when you only intend to refresh or briefly reconnect.</p>
      </Section>
    </Article>
  );
}

function CliPage() {
  return (
    <Article eyebrow="Terminal client" title="Play Cabo from the CLI." lede="The interactive terminal client exposes the same rooms, private knowledge, legal actions, and reconnect behavior as the Web table.">
      <Section id="install" title="Install and start">
        <p>The CLI requires Node.js 22 or newer.</p>
        <CodeBlock>{`npm install --global @cabo-game/cli
cabo --name Alice
cabo --server https://cabo-api.human404.link --name Alice`}</CodeBlock>
        <p><code>--server</code> selects the Cabo server. <code>--name</code> sets a player name up to 20 characters; otherwise the CLI uses the current operating-system user.</p>
      </Section>
      <Section id="connection" title="Connection commands">
        <CommandTable rows={[
          ["rooms", "Browse all public rooms. Use ↑/↓ to select, ←/→ to page, and Enter to join."],
          ['create public [target] --name "room name"', "Create a public room. A blank name uses [player]'s room."],
          ['create private [target] --name "room name"', "Create a private room, then enter a six-digit password without echo."],
          ["join ROOM [password]", "Join by case-sensitive room code, optionally with its password."],
          ["reconnect", "Reconnect to the locally saved seat."],
          ["quit", "Leave gracefully and exit the client."],
        ]} />
      </Section>
      <Section id="lobby" title="Lobby commands">
        <CommandTable rows={[
          ["players", "Show the current seats."],
          ["start", "Start once at least two players are connected; host only."],
          ["leave", "Release your seat but keep the CLI process open."],
        ]} />
      </Section>
      <Section id="game" title="Game commands">
        <CommandTable rows={[
          ["show", "Render the latest table and your remembered cards."],
          ["draw deck", "Draw a private card from the deck."],
          ["draw discard", "Take the top discard, then choose cards to replace."],
          ["replace POS [POS ...] [at POS]", "Replace one to four positions; at selects the new card’s position."],
          ["resolve LEFT [PENALTY]", "Place a mismatched draw and optional penalty at the left or right end."],
          ["discard", "Discard the deck card you are holding."],
          ["peek self POS", "Use a 7/8 power on one of your positions."],
          ["peek PLAYER POS", "Use a 9/10 power on another player’s position."],
          ["swap PLAYER POS", "Use a J/Q power to blind-swap the same position."],
          ["skip", "Skip the pending card power."],
          ["cabo", "Call Cabo at the beginning of your turn."],
        ]} />
      </Section>
      <Section id="interaction" title="Interaction notes">
        <p>Positions run from 1 through the current hand size. A player argument accepts an exact nickname or a session ID. Enter <code>help</code> or <code>?</code> to show the command reference.</p>
        <p>Room names may repeat and contain up to 40 Unicode characters. They are labels only: joining and reconnecting always use the room ID.</p>
        <p>In an interactive terminal, the CLI also offers numbered action menus. During a multi-step choice, enter <code>cancel</code> to return to the action menu.</p>
      </Section>
    </Article>
  );
}

function CommandTable({ rows }: { rows: Array<[string, string]> }) {
  return <div className="docs-table-wrap"><table><thead><tr><th>Command</th><th>Effect</th></tr></thead><tbody>{rows.map(([command, effect]) => <tr key={command}><td><code>{command}</code></td><td>{effect}</td></tr>)}</tbody></table></div>;
}

function AgentPage() {
  return (
    <Article eyebrow="Process interface" title="Drive Cabo from any language." lede="cabo-agent runs one player as a language-neutral JSONL subprocess. A supervisor in Python, Go, Rust, Node.js, or any other runtime can control it through standard streams.">
      <Section id="start-agent" title="Start an Agent">
        <CodeBlock>{`npm install --global @cabo-game/cli
cabo-agent --name Bot-A --request-timeout-ms 15000`}</CodeBlock>
        <p>Use <code>--server URL</code> for another server and <code>--session-file PATH</code> to persist reconnect state for this Agent. Give every concurrent Agent a distinct session file.</p>
        <CodeBlock>{`cabo-agent --help
cabo-agent --version
cabo-agent --print-schema`}</CodeBlock>
        <p>The discovery commands exit immediately and never connect to a server. The JSON Schema comes from the same definitions used by the running CLI.</p>
      </Section>
      <Section id="transport" title="Process contract">
        <ul>
          <li>stdin and stdout contain exactly one JSON object per line.</li>
          <li>stderr is diagnostics only; never parse its wording as protocol.</li>
          <li>Every request carries a unique, non-empty string <code>id</code>.</li>
          <li>Requests run serially, but pushed events and observations may appear before the matching result.</li>
          <li>The first frame is always <code>ready</code>; startup failures use a <code>fatal</code> frame and a non-zero exit.</li>
        </ul>
        <CodeBlock>{`{"type":"ready","protocolVersion":4,"cliVersion":"0.1.0","server":"https://cabo-api.human404.link","name":"Bot-A","sessionPersistence":false,"requestTimeoutMs":15000,"capabilities":["describe","ping","json-schema","request-timeout"]}
{"id":"about","type":"describe"}
{"id":"health","type":"ping"}`}</CodeBlock>
      </Section>
      <Section id="loop" title="The supervisor loop">
        <ol>
          <li>Wait for the <code>ready</code> frame.</li>
          <li>Send <code>create</code>, <code>join</code>, or <code>reconnect</code>.</li>
          <li>Keep the latest <code>observation</code> as the source of truth.</li>
          <li>Select a concrete action from <code>legalActions</code>. For <code>replace</code>, use its bounded position-selection descriptor.</li>
          <li>Send it inside an <code>action</code> request and correlate the eventual <code>result</code> by ID.</li>
          <li>Repeat when a newer observation arrives.</li>
        </ol>
        <CodeBlock>{`{"id":"create","type":"create","visibility":"public","targetScore":100,"roomName":"Bots' room"}
{"type":"observation","roomId":"abc123","roomName":"Bots' room","selfId":"session-id","revision":3,"state":{"phase":"TURN_START","round":1,"targetScore":100,"currentPlayerId":"session-id","caboCallerId":null,"drawSource":null,"mismatchPenaltyCardPending":false,"discardTop":{"label":"6H","rank":6},"deckCount":43,"players":[],"winners":[]},"knowledge":{"round":1,"slots":[{"label":"4C","rank":4},null,null,null],"opponents":[],"held":null},"legalActions":[{"type":"draw-deck"}]}
{"id":"move-1","type":"action","action":{"type":"draw-deck"}}
{"type":"result","id":"move-1","ok":true,"data":{"revision":4}}`}</CodeBlock>
      </Section>
      <Section id="state" title="State, events, and recovery">
        <p>An observation combines public game state, the Agent’s private remembered cards, and every currently legal concrete action. Successful state-changing results are emitted only after the client has observed their acknowledged revision.</p>
        <p>Use events for incremental logs and notifications, not as the authoritative game state. A request timeout returns <code>uncertain: true</code>; state-changing requests are then rejected with <code>STATE_UNCERTAIN</code> until a successful <code>observe</code> refreshes the view. <code>ping</code>, <code>leave</code>, and <code>shutdown</code> remain available.</p>
      </Section>
      <Section id="lifecycle" title="Sessions and shutdown">
        <p>Without <code>--session-file</code>, the Agent writes no reconnect state. With one, a successful <code>reconnect</code> can reclaim a seat that is still inside its grace period.</p>
        <ul>
          <li><code>leave</code> releases the seat and keeps the process running.</li>
          <li><code>shutdown</code> waits for the active request, leaves, returns a result, and exits 0.</li>
          <li>Closing stdin performs the same graceful shutdown.</li>
          <li>SIGINT and SIGTERM leave gracefully and exit 130 and 143.</li>
        </ul>
        <p>For every request and frame shape, read the <a href="https://github.com/allenhooray/cabo-game/blob/master/docs/agent-protocol.md">complete Agent JSONL protocol</a>.</p>
      </Section>
    </Article>
  );
}
