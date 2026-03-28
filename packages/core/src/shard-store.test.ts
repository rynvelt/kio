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
		test("unavailable → loading on grantAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			expect(store.snapshot.syncStatus).toBe("loading");
			expect(store.snapshot.state).toBeNull();
		});

		test("loading → latest on setState", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			store.setState({ turn: 0 }, 1);
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 0 });
		});

		test("latest → unavailable on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			store.setState({ turn: 0 }, 1);
			store.revokeAccess();
			expect(store.snapshot.syncStatus).toBe("unavailable");
			expect(store.snapshot.state).toBeNull();
		});

		test("latest → loading → latest (reconnect cycle)", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			store.setState({ turn: 0 }, 1);

			store.revokeAccess();
			store.grantAccess();
			expect(store.snapshot.syncStatus).toBe("loading");

			store.setState({ turn: 5 }, 6);
			expect(store.snapshot.syncStatus).toBe("latest");
			expect(store.snapshot.state).toEqual({ turn: 5 });
		});

		test("setState without grantAccess stays unavailable", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 1);
			expect(store.snapshot.syncStatus).toBe("unavailable");
		});
	});

	describe("subscriber notification", () => {
		test("notifies on setState", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.setState({ turn: 0 }, 1);
			expect(callCount).toBe(1);

			store.setState({ turn: 1 }, 2);
			expect(callCount).toBe(2);
		});

		test("notifies on grantAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.grantAccess();
			expect(callCount).toBe(1);
		});

		test("notifies on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			store.setState({ turn: 0 }, 1);

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.revokeAccess();
			expect(callCount).toBe(1);
		});

		test("does not notify after unsubscribe", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
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
			store.grantAccess();
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

		test("no duplicate notification on redundant grantAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();

			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.grantAccess();
			expect(callCount).toBe(0);
		});

		test("no duplicate notification on redundant revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			let callCount = 0;
			store.subscribe(() => {
				callCount += 1;
			});

			store.revokeAccess();
			expect(callCount).toBe(0);
		});
	});

	describe("version tracking", () => {
		test("version is null initially", () => {
			const store = new ShardStore<{ turn: number }>();
			expect(store.version).toBeNull();
		});

		test("version tracks received state", () => {
			const store = new ShardStore<{ turn: number }>();
			store.setState({ turn: 0 }, 5);
			expect(store.version).toBe(5);

			store.setState({ turn: 1 }, 6);
			expect(store.version).toBe(6);
		});

		test("version resets on revokeAccess", () => {
			const store = new ShardStore<{ turn: number }>();
			store.grantAccess();
			store.setState({ turn: 0 }, 5);
			store.revokeAccess();
			expect(store.version).toBeNull();
		});
	});
});
