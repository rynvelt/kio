import { describe, expect, test } from "bun:test";
import {
	createSubscriptionsChannel,
	KIO_SERVER_ACTOR,
	SUBSCRIPTIONS_CHANNEL_NAME,
	type SubscriptionRef,
} from "@kiojs/shared";
import { ChannelRuntime } from "./channel-runtime";
import { MemoryStateAdapter } from "./persistence";
import type { Submission } from "./pipeline";
import { SubscriptionResolver } from "./subscription-resolver";

/**
 * Build a SubscriptionResolver wired to a real subscriptions ChannelRuntime.
 * `submit` goes straight to the runtime — same semantics as the real server.
 */
function setupResolver(
	opts: {
		kind?: "ephemeral" | "durable";
		defaultSubscriptions?: (actor: {
			actorId: string;
		}) => readonly SubscriptionRef[];
	} = {},
) {
	const adapter = new MemoryStateAdapter();
	const subsChannel = createSubscriptionsChannel({
		kind: opts.kind ?? "ephemeral",
	});
	const subsRuntime = new ChannelRuntime(subsChannel["~data"], adapter, {
		serverActorId: KIO_SERVER_ACTOR.actorId,
	});

	const submit = (_channelName: string, submission: Submission) =>
		subsRuntime.submit(submission);

	const resolver = new SubscriptionResolver<{ actorId: string }>({
		subsChannel: subsRuntime,
		serverActor: KIO_SERVER_ACTOR,
		submit,
		defaultSubscriptions: opts.defaultSubscriptions,
	});

	return { resolver, subsRuntime, submit, adapter };
}

/** Helper: flatten the grouped result back into a ref list for assertions. */
function flatten(
	grouped: ReadonlyMap<string, readonly string[]>,
): SubscriptionRef[] {
	const refs: SubscriptionRef[] = [];
	for (const [channelId, shardIds] of grouped) {
		for (const shardId of shardIds) refs.push({ channelId, shardId });
	}
	return refs;
}

describe("SubscriptionResolver", () => {
	test("no subscriptions channel → empty result", async () => {
		const resolver = new SubscriptionResolver<{ actorId: string }>({
			subsChannel: undefined,
			serverActor: KIO_SERVER_ACTOR,
			submit: async () => {
				throw new Error("should not be called");
			},
		});
		const result = await resolver.resolveForActor({ actorId: "alice" });
		expect(result.size).toBe(0);
	});

	test("first connect without defaultSubscriptions → only own subscription shard", async () => {
		const { resolver } = setupResolver();
		const result = await resolver.resolveForActor({ actorId: "bob" });
		const refs = flatten(result);
		expect(refs).toEqual([
			{
				channelId: SUBSCRIPTIONS_CHANNEL_NAME,
				shardId: "subscription:bob",
			},
		]);
	});

	test("first connect with defaultSubscriptions → seeds shard, returns seeds + own", async () => {
		const { resolver, subsRuntime } = setupResolver({
			defaultSubscriptions: () => [
				{ channelId: "game", shardId: "world" },
				{ channelId: "presence", shardId: "player:alice" },
			],
		});

		const result = await resolver.resolveForActor({ actorId: "alice" });
		const refs = flatten(result);

		// Expected: game/world + presence/player:alice + subscriptions/subscription:alice
		expect(refs).toContainEqual({ channelId: "game", shardId: "world" });
		expect(refs).toContainEqual({
			channelId: "presence",
			shardId: "player:alice",
		});
		expect(refs).toContainEqual({
			channelId: SUBSCRIPTIONS_CHANNEL_NAME,
			shardId: "subscription:alice",
		});

		// Shard was actually seeded (version > 0 means grants landed).
		const loaded = await subsRuntime.loadShardStates(["subscription:alice"]);
		const cached = loaded.get("subscription:alice");
		expect(cached?.version).toBeGreaterThan(0);
		expect((cached?.state as { refs: SubscriptionRef[] }).refs).toHaveLength(2);
	});

	test("second connect (shard already seeded) → defaultSubscriptions NOT called again", async () => {
		let callCount = 0;
		const { resolver } = setupResolver({
			defaultSubscriptions: () => {
				callCount++;
				return [{ channelId: "game", shardId: "world" }];
			},
		});

		await resolver.resolveForActor({ actorId: "alice" });
		expect(callCount).toBe(1);

		await resolver.resolveForActor({ actorId: "alice" });
		expect(callCount).toBe(1); // NOT re-seeded

		await resolver.resolveForActor({ actorId: "alice" });
		expect(callCount).toBe(1);
	});

	test("revoke persists across reconnect (bootstrap does not undo it)", async () => {
		const { resolver, submit } = setupResolver({
			defaultSubscriptions: () => [{ channelId: "game", shardId: "world" }],
		});

		// First connect: seeds with world.
		const first = flatten(await resolver.resolveForActor({ actorId: "bob" }));
		expect(first).toContainEqual({ channelId: "game", shardId: "world" });

		// Admin revokes access to world.
		await submit(SUBSCRIPTIONS_CHANNEL_NAME, {
			operationName: "revoke",
			input: {
				actorId: "bob",
				ref: { channelId: "game", shardId: "world" },
			},
			actor: KIO_SERVER_ACTOR,
			opId: "admin:revoke",
		});

		// Second connect: no re-seed. world ref should be gone.
		const second = flatten(await resolver.resolveForActor({ actorId: "bob" }));
		expect(second).not.toContainEqual({
			channelId: "game",
			shardId: "world",
		});
		// Own shard still included.
		expect(second).toContainEqual({
			channelId: SUBSCRIPTIONS_CHANNEL_NAME,
			shardId: "subscription:bob",
		});
	});

	test("refs are grouped by channel in the output", async () => {
		const { resolver } = setupResolver({
			defaultSubscriptions: () => [
				{ channelId: "game", shardId: "world" },
				{ channelId: "game", shardId: "seat:1" },
				{ channelId: "presence", shardId: "player:alice" },
			],
		});

		const result = await resolver.resolveForActor({ actorId: "alice" });
		expect(result.get("game")).toEqual(["world", "seat:1"]);
		expect(result.get("presence")).toEqual(["player:alice"]);
		expect(result.get(SUBSCRIPTIONS_CHANNEL_NAME)).toEqual([
			"subscription:alice",
		]);
	});

	test("own-shard ref is not duplicated if consumer declares it", async () => {
		const { resolver } = setupResolver({
			defaultSubscriptions: (actor) => [
				// Weird but allowed: consumer explicitly seeds own shard.
				{
					channelId: SUBSCRIPTIONS_CHANNEL_NAME,
					shardId: `subscription:${actor.actorId}`,
				},
			],
		});

		const result = await resolver.resolveForActor({ actorId: "carol" });
		const ownShards = result.get(SUBSCRIPTIONS_CHANNEL_NAME) ?? [];
		expect(ownShards).toEqual(["subscription:carol"]);
	});
});
