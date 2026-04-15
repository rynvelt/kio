import { channel, engine, shard } from "@kio/shared";
import * as v from "valibot";

export const counterChannel = channel
	.durable("counter")
	.shard("count", v.object({ value: v.number() }))
	.operation("increment", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [shard.ref("count")],
		apply(shards) {
			shards.count.value += 1;
		},
	})
	.operation("decrement", {
		execution: "optimistic",
		input: v.object({}),
		scope: () => [shard.ref("count")],
		apply(shards) {
			shards.count.value -= 1;
		},
	})
	.operation("reset", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({}),
		scope: () => [shard.ref("count")],
		apply(shards) {
			shards.count.value = 0;
		},
	});

export const presenceChannel = channel
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
			if (!shards.users.connected.some((u) => u.id === input.id)) {
				shards.users.connected.push({ id: input.id });
			}
		},
	})
	.operation("leave", {
		execution: "optimistic",
		versionChecked: false,
		deduplicate: false,
		input: v.object({ id: v.string() }),
		scope: () => [shard.ref("users")],
		apply(shards, input) {
			const idx = shards.users.connected.findIndex((u) => u.id === input.id);
			if (idx >= 0) shards.users.connected.splice(idx, 1);
		},
	});

export const appEngine = engine()
	.register(counterChannel)
	.register(presenceChannel);
