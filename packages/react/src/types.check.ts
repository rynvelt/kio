/**
 * Type-level tests for @kio/react hooks.
 * No runtime — pure compile-time assertions via `just typecheck`.
 */

import { channel, engine, shard } from "@kio/shared";
import * as v from "valibot";
import { createKioHooks } from "./create-hooks";

// ── Test schema ─────────────────────────────────────────────────────

const counterChannel = channel
	.durable("counter")
	.shard("count", v.object({ value: v.number() }))
	.operation("increment", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [shard.ref("count")],
		apply(shards) {
			shards.count.value += 1;
		},
	});

const presenceChannel = channel
	.ephemeral("presence", { autoBroadcast: false })
	.shard(
		"users",
		v.object({ connected: v.array(v.object({ id: v.string() })) }),
	)
	.operation("join", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ id: v.string() }),
		scope: () => [shard.ref("users")],
		apply(shards, input) {
			shards.users.connected.push({ id: input.id });
		},
	});

const appEngine = engine().channel(counterChannel).channel(presenceChannel);

const { useShardState, useSubmit } = createKioHooks<typeof appEngine>();

// ── useShardState: positive ─────────────────────────────────────────

function _validShardState() {
	// Singleton shard — state is typed
	const counter = useShardState("counter", "count");
	if (counter.syncStatus === "latest") {
		const _v: number = counter.state.value;
	}

	const presence = useShardState("presence", "users");
	if (presence.syncStatus === "latest") {
		const _u: Array<{ id: string }> = presence.state.connected;
	}
}

// ── useShardState: negative ─────────────────────────────────────────

// @ts-expect-error: "nonexistent" is not a valid channel
useShardState("nonexistent", "count");

// @ts-expect-error: "nonexistent" is not a valid shard on "counter"
useShardState("counter", "nonexistent");

// ── useSubmit: positive ─────────────────────────────────────────────

function _validSubmit() {
	const submit = useSubmit("counter");
	submit("increment", {});
}

function _validSubmitPresence() {
	const submit = useSubmit("presence");
	submit("join", { id: "alice" });
}

// ── useSubmit: negative ─────────────────────────────────────────────

// @ts-expect-error: "nonexistent" is not a valid channel
useSubmit("nonexistent");

function _invalidOp() {
	const submit = useSubmit("counter");
	// @ts-expect-error: "nonexistent" is not a valid operation
	submit("nonexistent", {});
}

function _wrongInput() {
	const submit = useSubmit("presence");
	// @ts-expect-error: "join" requires { id: string }, not {}
	submit("join", {});
}
