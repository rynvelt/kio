import { describe, expect, test } from "bun:test";
import { ShardStore } from "./shard-store";

describe("ShardStore", () => {
	describe("initial state", () => {
		test("starts as unavailable", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			const snap = store.snapshot;
			expect(snap.syncStatus).toBe("unavailable");
			expect(snap.state).toBeNull();
			expect(snap.pending).toBeNull();
		});
	});

	describe("syncStatus transitions", () => {
		test("unavailable → loading on grantAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			expect(store.snapshot.syncStatus).toBe("loading");
			expect(store.snapshot.state).toBeNull();
		});

		test("loading → latest on setState", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 0 });
		});

		test("latest → unavailable on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.revokeAccess();
			expect(store.snapshot.syncStatus).toBe("unavailable");
			expect(store.snapshot.state).toBeNull();
		});

		test("reconnect cycle: latest → revoke → grant → loading → latest", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});

			store.revokeAccess();
			store.grantAccess();
			expect(store.snapshot.syncStatus).toBe("loading");

			store.applyBroadcastEntry({
				shardId: "world",
				version: 6,
				state: { turn: 5 },
			});
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 5 });
		});
	});

	describe("broadcast processing — full state", () => {
		test("applies full state entry", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 42 },
			});
			expect(store.snapshot.state).toEqual({ turn: 42 });
			expect(store.version).toBe(1);
		});

		test("updates on newer version", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.applyBroadcastEntry({
				shardId: "world",
				version: 2,
				state: { turn: 1 },
			});
			expect(store.snapshot.state).toEqual({ turn: 1 });
			expect(store.version).toBe(2);
		});
	});

	describe("broadcast processing — patches", () => {
		test("applies patches to existing state", () => {
			const store = new ShardStore<{ turn: number; stage: string }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0, stage: "PLAYING" },
			});
			store.applyBroadcastEntry({
				shardId: "world",
				version: 2,
				patches: [{ op: "replace", path: ["turn"], value: 1 }],
			});
			expect(store.snapshot.state).toEqual({ turn: 1, stage: "PLAYING" });
			expect(store.version).toBe(2);
		});

		test("ignores patches without existing state", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();

			let notified = false;
			store.subscribe(() => {
				notified = true;
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				patches: [{ op: "replace", path: ["turn"], value: 1 }],
			});

			expect(store.snapshot.syncStatus).toBe("loading");
			expect(notified).toBe(false);
		});
	});

	describe("broadcast processing — durable version check", () => {
		test("ignores stale broadcast (same version)", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 10 },
			});

			let notified = false;
			store.subscribe(() => {
				notified = true;
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 99 },
			});

			expect(store.snapshot.state).toEqual({ turn: 10 });
			expect(notified).toBe(false);
		});

		test("ignores stale broadcast (older version)", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 10 },
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 3,
				state: { turn: 0 },
			});

			expect(store.snapshot.state).toEqual({ turn: 10 });
			expect(store.version).toBe(5);
		});
	});

	describe("broadcast processing — ephemeral (no version check)", () => {
		test("always accepts, even with lower version", () => {
			const store = new ShardStore<{ lat: number }>("ephemeral");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "player:alice",
				version: 5,
				state: { lat: 48.8 },
			});
			store.applyBroadcastEntry({
				shardId: "player:alice",
				version: 3,
				state: { lat: 52.5 },
			});

			expect(store.snapshot.state).toEqual({ lat: 52.5 });
			expect(store.version).toBe(3);
		});
	});

	describe("subscriber notification", () => {
		test("notifies on broadcast entry", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			expect(callCount).toBe(1);
		});

		test("notifies on grantAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.grantAccess();
			expect(callCount).toBe(1);
		});

		test("notifies on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.revokeAccess();
			expect(callCount).toBe(1);
		});

		test("does not notify after unsubscribe", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			let callCount = 0;
			const unsub = store.subscribe(() => {
				callCount += 1;
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			expect(callCount).toBe(1);

			unsub();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 2,
				state: { turn: 1 },
			});
			expect(callCount).toBe(1);
		});

		test("does not notify on stale durable broadcast", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 10 },
			});

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.applyBroadcastEntry({
				shardId: "world",
				version: 3,
				state: { turn: 0 },
			});
			expect(callCount).toBe(0);
		});

		test("no duplicate notification on redundant grantAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.grantAccess();
			expect(callCount).toBe(0);
		});

		test("no duplicate notification on redundant revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.revokeAccess();
			expect(callCount).toBe(0);
		});
	});

	describe("optimistic — in-flight and prediction", () => {
		test("setOptimistic shows predicted state and pending", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});

			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			const snap = store.snapshot;
			expect(snap.state).toEqual({ turn: 1 });
			expect(snap.pending).toEqual({ operationName: "advanceTurn", input: {} });
		});

		test("hasInFlight is true after setOptimistic", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			expect(store.hasInFlight).toBe(false);

			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);
			expect(store.hasInFlight).toBe(true);
		});

		test("broadcast drops prediction, shows authoritative", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			// Someone else's broadcast
			store.applyBroadcastEntry({
				shardId: "world",
				version: 2,
				state: { turn: 99 },
				causedBy: { opId: "other:0", operation: "x", actor: "bob" },
			});

			const snap = store.snapshot;
			expect(snap.state).toEqual({ turn: 99 });
			// in-flight remains (awaiting server response)
			expect(snap.pending).toEqual({ operationName: "advanceTurn", input: {} });
		});

		test("broadcast with matching opId clears in-flight", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			// Our own broadcast confirms the operation
			store.applyBroadcastEntry({
				shardId: "world",
				version: 2,
				state: { turn: 1 },
				causedBy: { opId: "game:0", operation: "advanceTurn", actor: "alice" },
			});

			const snap = store.snapshot;
			expect(snap.state).toEqual({ turn: 1 });
			expect(snap.pending).toBeNull();
			expect(store.hasInFlight).toBe(false);
		});

		test("clearInFlight reverts to authoritative", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			store.clearInFlight();

			const snap = store.snapshot;
			expect(snap.state).toEqual({ turn: 0 });
			expect(snap.pending).toBeNull();
			expect(store.hasInFlight).toBe(false);
		});

		test("revokeAccess clears in-flight and prediction", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			store.revokeAccess();

			expect(store.snapshot.syncStatus).toBe("unavailable");
			expect(store.hasInFlight).toBe(false);
		});

		test("setOptimistic notifies subscribers", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);
			expect(callCount).toBe(1);
		});

		test("clearInFlight notifies subscribers", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 1,
				state: { turn: 0 },
			});
			store.setOptimistic(
				{ opId: "game:0", operationName: "advanceTurn", input: {} },
				{ turn: 1 },
			);

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.clearInFlight();
			expect(callCount).toBe(1);
		});

		test("clearInFlight is no-op when nothing in-flight", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.clearInFlight();
			expect(callCount).toBe(0);
		});
	});

	describe("version tracking", () => {
		test("version is null initially", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			expect(store.version).toBeNull();
		});

		test("version tracks received state", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 0 },
			});
			expect(store.version).toBe(5);
		});

		test("version resets on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>("durable");
			store.grantAccess();
			store.applyBroadcastEntry({
				shardId: "world",
				version: 5,
				state: { turn: 0 },
			});
			store.revokeAccess();
			expect(store.version).toBeNull();
		});
	});
});
