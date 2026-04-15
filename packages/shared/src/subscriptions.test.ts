import { describe, expect, test } from "bun:test";
import { produce } from "immer";
import { createSubscriptionsChannel } from "./subscriptions";

function getApply(
	ch: ReturnType<typeof createSubscriptionsChannel>,
	opName: "grant" | "revoke",
) {
	const impl = ch["~data"].serverImpls.get(opName);
	if (!impl?.apply) {
		throw new Error(`no apply for ${opName}`);
	}
	return impl.apply;
}

function applyGrant(
	ch: ReturnType<typeof createSubscriptionsChannel>,
	startState: { refs: Array<{ channelId: string; shardId: string }> },
	actorId: string,
	ref: { channelId: string; shardId: string },
) {
	const apply = getApply(ch, "grant");
	return produce(startState, (draft) => {
		apply(
			{
				subscription: (_resourceId: string) => draft,
			},
			{ actorId, ref },
			undefined,
			{ actor: { actorId: "__kio:server__" }, channelId: "subscriptions" },
		);
	});
}

function applyRevoke(
	ch: ReturnType<typeof createSubscriptionsChannel>,
	startState: { refs: Array<{ channelId: string; shardId: string }> },
	actorId: string,
	ref: { channelId: string; shardId: string },
) {
	const apply = getApply(ch, "revoke");
	return produce(startState, (draft) => {
		apply(
			{
				subscription: (_resourceId: string) => draft,
			},
			{ actorId, ref },
			undefined,
			{ actor: { actorId: "__kio:server__" }, channelId: "subscriptions" },
		);
	});
}

describe("createSubscriptionsChannel", () => {
	test("returns an ephemeral channel named subscriptions", () => {
		const ch = createSubscriptionsChannel({ kind: "ephemeral" });
		expect(ch.kind).toBe("ephemeral");
		expect(ch.name).toBe("subscriptions");
	});

	test("returns a durable channel when kind is durable", () => {
		const ch = createSubscriptionsChannel({ kind: "durable" });
		expect(ch.kind).toBe("durable");
		expect(ch.name).toBe("subscriptions");
	});

	test("declares one per-resource shard 'subscription'", () => {
		const ch = createSubscriptionsChannel({ kind: "ephemeral" });
		const data = ch["~data"];
		expect(data.shardDefs.size).toBe(1);
		const sub = data.shardDefs.get("subscription");
		expect(sub?.kind).toBe("perResource");
	});

	test("declares grant and revoke as confirmed + serverOnly", () => {
		const ch = createSubscriptionsChannel({ kind: "ephemeral" });
		const data = ch["~data"];

		const grant = data.operations.get("grant");
		expect(grant?.execution).toBe("confirmed");
		expect(grant?.serverOnly).toBe(true);
		expect(grant?.versionChecked).toBe(true);
		expect(grant?.deduplicate).toBe(false);

		const revoke = data.operations.get("revoke");
		expect(revoke?.execution).toBe("confirmed");
		expect(revoke?.serverOnly).toBe(true);
		expect(revoke?.versionChecked).toBe(true);
		expect(revoke?.deduplicate).toBe(false);
	});

	test("does not register a validate hook on grant or revoke", () => {
		// Authorization is enforced by `serverOnly`, not by overloading validate.
		const ch = createSubscriptionsChannel({ kind: "ephemeral" });
		const data = ch["~data"];
		expect(data.serverImpls.get("grant")?.validate).toBeUndefined();
		expect(data.serverImpls.get("revoke")?.validate).toBeUndefined();
	});
});

describe("subscriptions apply — grant", () => {
	const ch = createSubscriptionsChannel({ kind: "ephemeral" });

	test("adds a ref to an empty shard", () => {
		const next = applyGrant(ch, { refs: [] }, "bob", {
			channelId: "presence",
			shardId: "player:alice",
		});
		expect(next.refs).toHaveLength(1);
		expect(next.refs[0]).toEqual({
			channelId: "presence",
			shardId: "player:alice",
		});
	});

	test("is idempotent — granting an existing ref does nothing", () => {
		const start = {
			refs: [{ channelId: "presence", shardId: "player:alice" }],
		};
		const next = applyGrant(ch, start, "bob", {
			channelId: "presence",
			shardId: "player:alice",
		});
		expect(next.refs).toHaveLength(1);
	});

	test("distinguishes refs by channelId and shardId", () => {
		const start = {
			refs: [{ channelId: "presence", shardId: "player:alice" }],
		};
		// Same shardId, different channel — distinct ref
		const next = applyGrant(ch, start, "bob", {
			channelId: "game",
			shardId: "player:alice",
		});
		expect(next.refs).toHaveLength(2);
	});
});

describe("subscriptions apply — revoke", () => {
	const ch = createSubscriptionsChannel({ kind: "ephemeral" });

	test("removes a matching ref", () => {
		const start = {
			refs: [
				{ channelId: "presence", shardId: "player:alice" },
				{ channelId: "presence", shardId: "player:carol" },
			],
		};
		const next = applyRevoke(ch, start, "bob", {
			channelId: "presence",
			shardId: "player:alice",
		});
		expect(next.refs).toHaveLength(1);
		expect(next.refs[0]?.shardId).toBe("player:carol");
	});

	test("is a no-op when the ref is not present", () => {
		const start = {
			refs: [{ channelId: "presence", shardId: "player:alice" }],
		};
		const next = applyRevoke(ch, start, "bob", {
			channelId: "presence",
			shardId: "player:carol",
		});
		expect(next.refs).toEqual(start.refs);
	});
});
