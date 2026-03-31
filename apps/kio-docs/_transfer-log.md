# VISION_v2.md Transfer Log

This file maps every section and subsection of VISION_v2.md to its destination
page(s) in the Starlight documentation. It is the single source of truth for
tracking transfer progress.

**How to use:**
1. Before starting a chunk, read this file to find the next "Not Started" group.
2. After transferring content, update the Status column to "Done".
3. Add `<!-- TRANSFERRED: target-page.md -->` markers in VISION_v2.md.
4. After all chunks are done, scan VISION_v2.md for unmarked text.

## Transfer Map

| Chunk | VISION_v2 Section | Subsection | Lines | Target Page(s) | Status |
|---|---|---|---|---|---|
| 1 | §1 Data Model | Channels intro (L9–L25) | 9–25 | concepts/channels.md | Done |
| 1 | §1 Data Model | Broadcast control (L26–L60) | 26–60 | concepts/channels.md | Done |
| 1 | §1 Data Model | Ephemeral channel semantics (L62–L79) | 62–79 | concepts/channels.md | Done |
| 1 | §1 Data Model | Shards intro (L81–L109) | 81–109 | concepts/shards.md | Done |
| 1 | §1 Data Model | State Ownership (L111–L124) | 111–124 | concepts/shards.md | Done |
| 1 | §1 Data Model | Subscription Shard (L125–L197) | 125–197 | concepts/subscriptions.md | Done |
| 2 | §2 Operations | What is an operation (L200–L253) | 200–253 | concepts/operations.md | Done |
| 2 | §2 Operations | Operation Flags (L255–L311) | 255–311 | concepts/operation-flags.md | Done |
| 2 | §2 Operations | Submit Result (L313–L343) | 313–343 | concepts/operations.md | Done |
| 2 | §2 Operations | Retry on Rejection (L345–L362) | 345–362 | concepts/operations.md | Done |
| 2 | §2 Operations | Privacy via Shard Design (L364–L373) | 364–373 | concepts/operations.md | Done |
| 2 | §2 Operations | Server as Actor (L375–L389) | 375–389 | concepts/operations.md | Done |
| 3 | §3 Broadcasting | Broadcasting intro (L393–L429) | 393–429 | concepts/broadcasting.md | Done |
| 3 | §3 Broadcasting | Broadcast types (L399–L449) | 399–449 | concepts/broadcasting.md | Done |
| 3 | §3 Broadcasting | Patch-based broadcasting (L431–L449) | 431–449 | concepts/broadcasting.md | Done |
| 3 | §3 Broadcasting | Client-Side State (L451–L515) | 451–515 | concepts/client-state.md | Done |
| 3 | §3 Broadcasting | ShardStore — Implementation (L517–L601) | 517–601 | concepts/client-state.md | Done |
| 4 | §4 Lifecycle | Server-Side Pipeline (L605–L628) | 605–628 | concepts/conflict-resolution.md | Done |
| 4 | §4 Lifecycle | Failure Modes (L630–L636) | 630–636 | concepts/conflict-resolution.md | Done |
| 4 | §4 Lifecycle | Conflict Resolution (L638–L651) | 638–651 | concepts/conflict-resolution.md | Done |
| 4 | §4 Lifecycle | Recovery (L653–L662) | 653–662 | concepts/conflict-resolution.md | Done |
| 4 | §4 Lifecycle | Error Model (L663–L767) | 663–767 | concepts/error-model.md | Done |
| 5 | §5 Architecture | Layers (L770–L788) | 770–788 | reference/architecture.md | Done |
| 5 | §5 Architecture | Packages (L790–L805) | 790–805 | reference/architecture.md | Done |
| 5 | §5 Architecture | Type Safety — Builder pattern (L807–L831) | 807–831 | concepts/type-safety.md | Done |
| 5 | §5 Architecture | Type Safety — Three-file split (L833–L941) | 833–941 | concepts/type-safety.md | Done |
| 6 | §6 Transport | Transport Interface (L944–L1004) | 944–1004 | reference/transport.md | Done |
| 6 | §6 Transport | Engine Message Protocol (L1006–L1027) | 1006–1027 | reference/message-protocol.md | Done |
| 6 | §6 Transport | Adapter Implementations (L1029–L1032) | 1029–1032 | reference/transport.md | Done |
| 6 | §6 Transport | Connection Lifecycle (L1034–L1103) | 1034–1103 | reference/connection-lifecycle.md | Done |
| 6 | §6 Transport | Liveness and Presence (L1105–L1128) | 1105–1128 | reference/transport.md, guides/presence.md | Done |
| 7 | §7 Persistence | Adapter Interface (L1132–L1167) | 1132–1167 | reference/persistence.md | Done |
| 7 | §7 Persistence | Conformance Tests (L1169–L1188) | 1169–1188 | reference/persistence.md | Done |
| 7 | §8 Hooks | Connection Lifecycle hooks (L1191–L1201) | 1191–1201 | reference/hooks.md | Done |
| 7 | §8 Hooks | Authorization hooks (L1203–L1227) | 1203–1227 | reference/hooks.md | Done |
| 7 | §8 Hooks | Subscriptions and subscriber map (L1209–L1227) | 1209–1227 | reference/hooks.md | Done |
| 7 | §8 Hooks | Operation Lifecycle hooks (L1229–L1235) | 1229–1235 | reference/hooks.md | Done |
| 7 | §8 Hooks | Serialization / Codec (L1237–L1246) | 1237–1246 | reference/hooks.md | Done |
| 7 | §9 Scope | In scope (L1249–L1268) | 1249–1268 | reference/scope.md | Done |
| 7 | §9 Scope | Out of scope (L1270–L1278) | 1270–1278 | reference/scope.md | Done |
| 7 | §10 Testing | Type-level tests (L1281–L1373) | 1281–1373 | reference/testing.md | Done |
| 7 | §10 Testing | Runtime tests (L1375–L1386) | 1375–1386 | reference/testing.md | Done |
| 7 | §10 Testing | Adapter conformance tests (L1388–L1392) | 1388–1392 | reference/testing.md | Done |
| 8 | §11 DSL Example | schema.ts (L1394–L1519) | 1394–1519 | guides/defining-schema.md | Done |
| 8 | §11 DSL Example | schema.server.ts (L1521–L1590) | 1521–1590 | guides/server-setup.md | Done |
| 8 | §11 DSL Example | schema.client.ts (L1592–L1619) | 1592–1619 | guides/client-setup.md | Done |
| 8 | §11 DSL Example | server.ts (L1621–L1682) | 1621–1682 | guides/server-setup.md | Done |
| 8 | §11 DSL Example | client.ts (L1684–L1709) | 1684–1709 | guides/client-setup.md | Done |
| 8 | §11 DSL Example | React integration (L1711–L1762) | 1711–1762 | guides/react-integration.md | Done |
| 8 | §11 DSL Example | Location sharing (L1764–L1836) | 1764–1836 | guides/location-sharing.md | Done |
| 9 | — | Intro paragraph (L1–L6) | 1–6 | index.md | Done |

## Verification Checklist

After all chunks are transferred:

- [ ] Every row above is "Done"
- [ ] Every section in VISION_v2.md has a `<!-- TRANSFERRED -->` marker
- [ ] `project/status.md` reflects actual code state
- [ ] `project/decisions.md` captures key ADRs
- [ ] All cross-references between pages are valid links
