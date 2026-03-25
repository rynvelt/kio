---
title: Design Decisions
description: Key architectural choices and their rationale
sidebar:
  order: 2
---

## Decision Log

Significant design decisions are documented here as lightweight ADRs (Architecture Decision Records).

### State broadcasting, not operation replay

**Context:** Should the server broadcast operations for clients to replay, or broadcast resulting state?

**Decision:** Broadcast state snapshots. Each broadcast is self-contained truth.

**Rationale:** Can never diverge. Ordering doesn't matter (version comparison). Recovery is trivial. Sharding makes it efficient (per-resource shards are small).

**Source:** VISION_v2.md Section 3

---

### Immer for apply()

**Context:** How should `apply()` handle state mutations?

**Decision:** Use Immer drafts in `apply()`. Consumers write mutative code; engine produces immutable results.

**Rationale:** Natural mutation syntax. Structural sharing. Safe rollback on throw. Patches captured automatically for broadcast.

**Source:** VISION_v2.md Section 2

---

### Three-file schema split

**Context:** How to share types between client and server without bundling the wrong code?

**Decision:** `schema.ts` (shared), `schema.server.ts` (validate/compute/apply for non-optimistic), `schema.client.ts` (canRetry). Compiler-enforced placement.

**Rationale:** Client never bundles validation/compute logic. Server never bundles retry logic. The `execution` flag determines where `apply()` lives — wrong placement is a type error.

**Source:** VISION_v2.md Section 5

---

*More decisions will be extracted during content transfer.*
