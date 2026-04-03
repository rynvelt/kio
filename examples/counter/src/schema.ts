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

export const appEngine = engine().channel(counterChannel);
