import { describe, expect, test } from "bun:test";
import { ShardStore } from "./shard-store";

describe("ShardStore", () => {
	describe("initial state", () => {
		test("starts as unavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			const snap = store.snapshot;
			expect(snap.syncStatus).toBe("unavailable");
			expect(snap.state).toBeNull();
			expect(snap.pending).toBeNull();
		});
	});

	describe("syncStatus transitions", () => {
		test("unavailable → loading", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setLoading();
			expect(store.snapshot.syncStatus).toBe("loading");
			expect(store.snapshot.state).toBeNull();
		});

		test("loading → latest via setState", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setLoading();
			store.setState({ turn: 0 }, 1);
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 0 });
		});

		test("latest → unavailable (access revoked)", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			store.setUnavailable();
			expect(store.snapshot.syncStatus).toBe("unavailable");
			expect(store.snapshot.state).toBeNull();
		});

		test("latest → loading → latest (reconnect cycle)", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			store.setLoading();
			expect(store.snapshot.syncStatus).toBe("loading");

			store.setState({ turn: 5 }, 6);
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 5 });
		});

		test("setState directly from unavailable goes to latest", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			expect(store.snapshot.syncStatus).toBe("latest");
		});
	});

	describe("subscriber notification", () => {
		test("notifies on setState", () => {
			const store = new ShardStore<{ turn: number }>();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setState({ turn: 0 }, 1);
			expect(callCount).toBe(1);

			store.setState({ turn: 1 }, 2);
			expect(callCount).toBe(2);
		});

		test("notifies on setLoading", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setLoading();
			expect(callCount).toBe(1);
		});

		test("notifies on setUnavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setUnavailable();
			expect(callCount).toBe(1);
		});

		test("does not notify after unsubscribe", () => {
			const store = new ShardStore<{ turn: number }>();
			let callCount = 0;
			const unsub = store.subscribe(() => {
				callCount += 1;
			});

			store.setState({ turn: 0 }, 1);
			expect(callCount).toBe(1);

			unsub();
			store.setState({ turn: 1 }, 2);
			expect(callCount).toBe(1);
		});

		test("multiple subscribers all notified", () => {
			const store = new ShardStore<{ turn: number }>();
			let count1 = 0;
			let count2 = 0;
			store.subscribe(() => {
				count1 += 1;
			});
			store.subscribe(() => {
				count2 += 1;
			});

			store.setState({ turn: 0 }, 1);
			expect(count1).toBe(1);
			expect(count2).toBe(1);
		});

		test("no duplicate notification on redundant setLoading", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setLoading();

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setLoading(); // already loading
			expect(callCount).toBe(0);
		});

		test("no duplicate notification on redundant setUnavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setUnavailable(); // already unavailable
			expect(callCount).toBe(0);
		});
	});

	describe("snapshot stability", () => {
		test("returns same reference when nothing changed", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			const snap1 = store.snapshot;
			const snap2 = store.snapshot;
			expect(snap1).toBe(snap2);
		});

		test("returns new reference after setState", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			const snap1 = store.snapshot;
			store.setState({ turn: 1 }, 2);
			const snap2 = store.snapshot;
			expect(snap1).not.toBe(snap2);
		});
	});

	describe("version tracking", () => {
		test("version is null when unavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			expect(store.version).toBeNull();
		});

		test("version tracks authoritative state", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 5);
			expect(store.version).toBe(5);

			store.setState({ turn: 1 }, 6);
			expect(store.version).toBe(6);
		});

		test("version resets to null on setUnavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 5);
			store.setUnavailable();
			expect(store.version).toBeNull();
		});
	});
});
