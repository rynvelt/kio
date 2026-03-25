---
title: Kio
description: Authoritative state synchronization engine for real-time multiplayer applications
template: splash
hero:
  title: Kio
  tagline: Authoritative state synchronization for real-time multiplayer apps
  actions:
    - text: Concepts
      link: /concepts/channels/
      icon: right-arrow
    - text: Guides
      link: /guides/defining-schema/
      icon: right-arrow
      variant: minimal
---

import { Card, CardGrid } from '@astrojs/starlight/components';

## What is Kio?

Kio is a framework for building real-time, multiplayer applications where the **server owns the truth** and clients stay in sync. It handles conflict resolution, optimistic updates, reconnection recovery, and state persistence — so you define *what* your state and operations look like, and Kio handles *how* they stay consistent.

Not a communication library — typing messages and sending them over a wire is already easy with socket.io. The value is in the **state management** around it.

<CardGrid>
	<Card title="Concepts" icon="open-book">
		Understand the mental models: channels, shards, operations, broadcasting.
	</Card>
	<Card title="Reference" icon="setting">
		API interfaces, message protocols, hooks, and package structure.
	</Card>
	<Card title="Guides" icon="rocket">
		Step-by-step walkthroughs for defining schemas and wiring up client/server.
	</Card>
	<Card title="Project Status" icon="list-format">
		Implementation progress tracking and design decisions.
	</Card>
</CardGrid>

:::caution[Early Stage]
Kio is in active exploration. These docs describe the target design. See [Project Status](/project/status/) for what's implemented.
:::
