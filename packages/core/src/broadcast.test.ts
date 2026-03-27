import { describe, expect, test } from "bun:test";
import type { Patch } from "immer";
import {
	BroadcastManager,
	type BroadcastMessage,
	type Subscriber,
} from "./broadcast";

function createSubscriber(
	id: string,
): Subscriber & { messages: BroadcastMessage[] } {
	const messages: BroadcastMessage[] = [];
	return {
		id,
		messages,
		send(message: BroadcastMessage) {
			messages.push(message);
		},
	};
}

const testPatches: Patch[] = [{ op: "replace", path: ["turn"], value: 1 }];
const testCausedBy = { operation: "advanceTurn", actor: "player:alice" };

function callApplied(mgr: BroadcastManager, shardId = "world", version = 2) {
	mgr.onOperationApplied(
		new Map([[shardId, testPatches]]),
		new Map([[shardId, version]]),
		testCausedBy,
	);
}

describe("BroadcastManager — autoBroadcast: true", () => {
	test("sends patches immediately on operation applied", () => {
		const mgr = new BroadcastManager("game", "durable", true);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["world"]);

		callApplied(mgr);

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.shards).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		expect(entry?.shardId).toBe("world");
		expect(entry?.version).toBe(2);
		expect(entry && "patches" in entry).toBe(true);
	});

	test("does not send to unsubscribed shards", () => {
		const mgr = new BroadcastManager("game", "durable", true);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["seat:1"]);

		callApplied(mgr);

		expect(sub.messages).toHaveLength(0);
	});

	test("sends to multiple subscribers", () => {
		const mgr = new BroadcastManager("game", "durable", true);
		const alice = createSubscriber("alice");
		const bob = createSubscriber("bob");
		mgr.addSubscriber(alice, ["world"]);
		mgr.addSubscriber(bob, ["world"]);

		callApplied(mgr);

		expect(alice.messages).toHaveLength(1);
		expect(bob.messages).toHaveLength(1);
	});

	test("includes causedBy metadata", () => {
		const mgr = new BroadcastManager("game", "durable", true);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["world"]);

		callApplied(mgr);

		const entry = sub.messages[0]?.shards[0];
		expect(entry?.causedBy?.operation).toBe("advanceTurn");
		expect(entry?.causedBy?.actor).toBe("player:alice");
	});

	test("removed subscriber receives nothing", () => {
		const mgr = new BroadcastManager("game", "durable", true);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["world"]);
		mgr.removeSubscriber("alice");

		callApplied(mgr);

		expect(sub.messages).toHaveLength(0);
	});
});

describe("BroadcastManager — autoBroadcast: false", () => {
	test("operation applied marks dirty, flush sends full state", () => {
		const mgr = new BroadcastManager("presence", "ephemeral", false);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["player:bob"]);

		callApplied(mgr, "player:bob", 3);

		// Nothing sent yet
		expect(sub.messages).toHaveLength(0);

		mgr.broadcastDirtyShards((id) => {
			if (id === "player:bob")
				return { state: { gps: { lat: 1, lng: 2 } }, version: 3 };
			return undefined;
		});

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		expect(entry?.shardId).toBe("player:bob");
		expect(entry && "state" in entry).toBe(true);
		if (entry && "state" in entry) {
			expect(entry.state).toEqual({ gps: { lat: 1, lng: 2 } });
		}
	});

	test("flush clears dirty set — second flush sends nothing", () => {
		const mgr = new BroadcastManager("presence", "ephemeral", false);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["player:bob"]);

		callApplied(mgr, "player:bob");

		const getState = () => ({ state: { gps: null }, version: 1 });

		mgr.broadcastDirtyShards(getState);
		expect(sub.messages).toHaveLength(1);

		mgr.broadcastDirtyShards(getState);
		expect(sub.messages).toHaveLength(1);
	});

	test("multiple operations coalesce into one flush", () => {
		const mgr = new BroadcastManager("presence", "ephemeral", false);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["player:bob"]);

		callApplied(mgr, "player:bob", 1);
		callApplied(mgr, "player:bob", 2);
		callApplied(mgr, "player:bob", 3);

		mgr.broadcastDirtyShards(() => ({
			state: { gps: { lat: 9, lng: 9 } },
			version: 5,
		}));

		expect(sub.messages).toHaveLength(1);
		const entry = sub.messages[0]?.shards[0];
		if (entry && "state" in entry) {
			expect(entry.state).toEqual({ gps: { lat: 9, lng: 9 } });
			expect(entry.version).toBe(5);
		}
	});

	test("selective flush by shard ID", () => {
		const mgr = new BroadcastManager("presence", "ephemeral", false);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["player:bob", "player:carol"]);

		callApplied(mgr, "player:bob");
		callApplied(mgr, "player:carol");

		const getState = (id: string) => ({ state: { who: id }, version: 1 });

		mgr.broadcastDirtyShards(getState, ["player:bob"]);

		expect(sub.messages).toHaveLength(1);
		expect(sub.messages[0]?.shards).toHaveLength(1);
		expect(sub.messages[0]?.shards[0]?.shardId).toBe("player:bob");

		// carol is still dirty
		mgr.broadcastDirtyShards(getState);
		expect(sub.messages).toHaveLength(2);
		expect(sub.messages[1]?.shards[0]?.shardId).toBe("player:carol");
	});

	test("only marks dirty for subscribed shards", () => {
		const mgr = new BroadcastManager("presence", "ephemeral", false);
		const sub = createSubscriber("alice");
		mgr.addSubscriber(sub, ["player:bob"]);

		callApplied(mgr, "player:carol");

		const getState = () => ({ state: {}, version: 1 });
		mgr.broadcastDirtyShards(getState);

		expect(sub.messages).toHaveLength(0);
	});
});
