---
title: Implementation Status
description: What's implemented, in progress, and still design-only
sidebar:
  order: 1
---

## Status Matrix

| Feature | Status | Notes |
|---|---|---|
| **Core types & builder** | Exploratory | Channel builder, shard refs, operation context types in `@kio/core` |
| **Immer composed root** | Exploratory | PoC test passing for multi-shard apply |
| **Three-file split** | Exploratory | StreetEscapes example exercising the API shape |
| **Server engine pipeline** | Design Only | See [Phase 2 plan](https://github.com/...) |
| **Client ShardStore** | Design Only | |
| **Transport adapters** | Design Only | |
| **Persistence adapters** | Design Only | |
| **Subscription shard** | Design Only | |
| **React hooks** | Design Only | |
| **Error model** | Design Only | |

## Status Levels

- **Implemented** — code exists, tested, matches the docs
- **In Progress** — partially built
- **Exploratory** — design may still change, initial code exists
- **Design Only** — spec exists in docs, no code yet
