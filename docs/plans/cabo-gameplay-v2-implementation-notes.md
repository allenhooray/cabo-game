# Cabo gameplay v2 implementation notes

## Delivered contract

The server, Web, interactive CLI and JSONL Agent share protocol v7. New rooms explicitly supply `memoryMode` and `turnDurationSeconds`; UI defaults are classic and 60 seconds. Missing settings and the old single-position swap are rejected.

The server owns one timeout with a generation guard. Valid game steps and automatic actions use the same execution/knowledge/event pipeline. Normal turns support 0/30/60/90 seconds; round results always advance after 20 seconds or earlier when everyone is ready. Disconnects do not pause this clock.

Classic snapshots retain only an unresolved held card, never historical slots. Assisted snapshots remain authoritative after reconnect. Web and interactive CLI use ephemeral reveals, and Agent/noninteractive CLI receive one-time events. This is not an anti-recording mechanism.

## Clarifications and implementation decisions

- Exhaustion edge case: repeated mismatches can put every card into hands, emptying both draw sources. On timeout the server calls Cabo if it has not been called; an exhausted final turn accepts the existing `skip` command through the shared engine. Web, CLI and Agent expose this narrowly scoped final-turn action, including unlimited rooms. This extends the planned discard fallback to avoid an otherwise unresolvable state; a fake-clock regression covers the full sequence.

- `deadlineAt` and `serverTime` are server output, not create inputs. Both use the Colyseus numeric schema and epoch milliseconds; real-browser countdown and round-transition tests exercise serialization.
- Private reveal messages additionally include `round`, `memoryMode`, and `ownerId`. Events can precede the public state patch, so these fields prevent misattributing an opening reveal or an opponent peek.
- Local saved knowledge is never replayed over a server snapshot, including assisted mode. Classic sessions omit historical knowledge entirely.
- Pending Web confirmations and CLI selections bind to the authoritative revision. Any state revision change cancels them, including reconnects.
- Successful invite joins persist the validated target server and remove only the invitation query parameters. Clipboard denial exposes the complete string for manual copying.
- Classic temporary cards are cleared when affected positions move, preventing a brief reveal from showing the wrong card after an exchange.
- No migration, legacy protocol adapter, bot takeover, timeout strike system, spectator or replay feature was added.

## Validation

Automated coverage includes asymmetric swaps, knowledge isolation, protocol rejection, explicit replacement destinations, risk models, fake-clock timeout phases/races/cleanup, and desktop/mobile browser flows for invitations, both memory modes, reconnects and unconfirmed round transitions. Run `pnpm test`, `pnpm typecheck`, `pnpm build` and `pnpm test:e2e` before coordinated deployment.

Final local validation: 163 unit/integration tests and type checking passed. The 12 unaffected browser scenarios passed in the full run, followed by all 4 focused classic/assisted desktop/mobile scenarios after tightening their reconnect synchronization. Screenshot baselines were reviewed and updated for the new controls. E2E reconnect assertions wait for both disconnect and reconnect revisions to settle before opening a new confirmation; the initial turn is randomly assigned, not assumed to belong to the host.
