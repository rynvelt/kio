import { describe, expect, test } from "bun:test";
import type { BaseActor } from "@kio/shared";
import { AfterCommitHooks } from "./after-commit-hooks";
import type { PipelineResult } from "./pipeline";
import type { AfterCommitContext, AfterCommitSubmitFn } from "./server";

const actor: BaseActor = { actorId: "test-actor" };

function mockResult(
	operationName: string,
	opId = "op-1",
): PipelineResult & { status: "acknowledged" } {
	return {
		status: "acknowledged",
		opId,
		operationName,
		shardVersions: new Map(),
		patchesByShard: new Map(),
		newState: {},
	};
}

// A submit stub that tests can forward-check but that we don't expect to be called
// unless the test explicitly invokes it.
const stubSubmit: AfterCommitSubmitFn<object> = () => {
	throw new Error("stubSubmit should not be called in this test");
};

describe("AfterCommitHooks", () => {
	test("register + run invokes handler with full context", async () => {
		const hooks = new AfterCommitHooks<object>();
		const calls: AfterCommitContext<unknown, object>[] = [];

		hooks.register("game", "advanceTurn", (ctx) => {
			calls.push(ctx);
		});

		await hooks.run(
			"game",
			mockResult("advanceTurn", "op-42"),
			actor,
			{ hint: true },
			0,
			stubSubmit,
		);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.operationName).toBe("advanceTurn");
		expect(calls[0]?.opId).toBe("op-42");
		expect(calls[0]?.actor).toEqual(actor);
		expect(calls[0]?.input).toEqual({ hint: true });
		expect(calls[0]?.newState).toEqual({});
		expect(calls[0]?.submit).toBe(stubSubmit);
	});

	test("run is a no-op when no handler is registered for (channel, op)", async () => {
		const hooks = new AfterCommitHooks<object>();
		hooks.register("game", "advanceTurn", () => {
			throw new Error("should not be called");
		});

		// Different op name — no handlers
		await expect(
			hooks.run("game", mockResult("otherOp"), actor, {}, 0, stubSubmit),
		).resolves.toBeUndefined();

		// Different channel — no handlers
		await expect(
			hooks.run(
				"presence",
				mockResult("advanceTurn"),
				actor,
				{},
				0,
				stubSubmit,
			),
		).resolves.toBeUndefined();
	});

	test("multiple handlers on same (channel, op) run in registration order", async () => {
		const hooks = new AfterCommitHooks<object>();
		const order: string[] = [];

		hooks.register("game", "advanceTurn", () => {
			order.push("a");
		});
		hooks.register("game", "advanceTurn", () => {
			order.push("b");
		});
		hooks.register("game", "advanceTurn", () => {
			order.push("c");
		});

		await hooks.run(
			"game",
			mockResult("advanceTurn"),
			actor,
			{},
			0,
			stubSubmit,
		);

		expect(order).toEqual(["a", "b", "c"]);
	});

	test("handlers on different channels are isolated", async () => {
		const hooks = new AfterCommitHooks<object>();
		const fired: string[] = [];

		hooks.register("game", "op", () => {
			fired.push("game");
		});
		hooks.register("presence", "op", () => {
			fired.push("presence");
		});

		await hooks.run("game", mockResult("op"), actor, {}, 0, stubSubmit);
		expect(fired).toEqual(["game"]);

		await hooks.run("presence", mockResult("op"), actor, {}, 0, stubSubmit);
		expect(fired).toEqual(["game", "presence"]);
	});

	test("throws when depth >= maxDepth and handlers exist", async () => {
		const hooks = new AfterCommitHooks<object>(3);
		hooks.register("game", "advanceTurn", () => {});

		await expect(
			hooks.run("game", mockResult("advanceTurn"), actor, {}, 3, stubSubmit),
		).rejects.toThrow(/afterCommit depth limit exceeded \(3\)/);
	});

	test("does not throw at depth limit when no handlers are registered", async () => {
		const hooks = new AfterCommitHooks<object>(3);
		// No handlers for "advanceTurn"

		await expect(
			hooks.run("game", mockResult("advanceTurn"), actor, {}, 99, stubSubmit),
		).resolves.toBeUndefined();
	});

	test("maxDepth is configurable via constructor (default 10)", async () => {
		const defaultHooks = new AfterCommitHooks<object>();
		defaultHooks.register("game", "op", () => {});

		// At depth 9 — still under the default limit of 10
		await expect(
			defaultHooks.run("game", mockResult("op"), actor, {}, 9, stubSubmit),
		).resolves.toBeUndefined();

		// At depth 10 — exceeds default
		await expect(
			defaultHooks.run("game", mockResult("op"), actor, {}, 10, stubSubmit),
		).rejects.toThrow(/depth limit exceeded \(10\)/);

		const customHooks = new AfterCommitHooks<object>(1);
		customHooks.register("game", "op", () => {});

		// At depth 0 — OK
		await expect(
			customHooks.run("game", mockResult("op"), actor, {}, 0, stubSubmit),
		).resolves.toBeUndefined();

		// At depth 1 — exceeds custom limit
		await expect(
			customHooks.run("game", mockResult("op"), actor, {}, 1, stubSubmit),
		).rejects.toThrow(/depth limit exceeded \(1\)/);
	});

	test("submit argument is forwarded to handlers unchanged", async () => {
		const hooks = new AfterCommitHooks<object>();
		let received: AfterCommitSubmitFn<object> | undefined;
		hooks.register("game", "op", (ctx) => {
			received = ctx.submit;
		});

		const customSubmit: AfterCommitSubmitFn<object> = () => {
			throw new Error("unused");
		};

		await hooks.run("game", mockResult("op"), actor, {}, 0, customSubmit);

		expect(received).toBe(customSubmit);
	});
});
