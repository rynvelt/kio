import * as v from "valibot";
import { type ChannelBuilder, createChannelBuilder } from "./channel";
import { shard } from "./shard";

// ── TypedSubscriptionRef ───────────────────────────────────────────────

/** Extract ShardDefs from a ChannelBuilder */
type ExtractShardDefs<Ch> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer D, infer _O, infer _A>
		? D
		: never;

/**
 * Valid `shardId` strings for a channel:
 * - singletons: the bare shard name.
 * - per-resource: `${shardType}:${resourceId}` where the prefix is fixed
 *   by the schema and the suffix is any string.
 */
type ShardIdsOf<Ch> =
	| (keyof ExtractShardDefs<Ch>["singletons"] & string)
	| {
			[K in keyof ExtractShardDefs<Ch>["perResource"] &
				string]: `${K}:${string}`;
	  }[keyof ExtractShardDefs<Ch>["perResource"] & string];

/**
 * Narrowed {@link SubscriptionRef} for APIs that know which engine is in
 * play. Distributed union keyed on `channelId` — once the caller writes
 * `channelId: "presence"`, TypeScript narrows `shardId` to that channel's
 * allowed forms (singleton names and per-resource prefixes). Consumers
 * that hand-construct `{ channelId, shardId }` literals at call sites
 * get typos caught at compile time without any helper factory.
 *
 * Structurally assignable to {@link SubscriptionRef}, so internal
 * plumbing can treat the two interchangeably.
 */
export type TypedSubscriptionRef<TChannels> = {
	[C in keyof TChannels & string]: {
		readonly channelId: C;
		readonly shardId: ShardIdsOf<TChannels[C]>;
	};
}[keyof TChannels & string];

/** The fixed channel name used for the engine-managed subscriptions channel. */
export const SUBSCRIPTIONS_CHANNEL_NAME = "subscriptions" as const;

/**
 * A reference to a single shard on a single channel — used both as an
 * entry in the subscription shard's `refs` list and as the argument shape
 * for `grantSubscription` / `revokeSubscription` / `defaultSubscriptions`.
 */
export interface SubscriptionRef {
	readonly channelId: string;
	readonly shardId: string;
}

/**
 * State shape of the per-actor subscription shard on the built-in
 * `subscriptions` channel. `refs` lists every shard the actor is allowed
 * to read (receive broadcasts for).
 */
export interface SubscriptionShardState {
	readonly refs: readonly SubscriptionRef[];
}

// ── Schemas ────────────────────────────────────────────────────────────

const entrySchema = v.object({
	channelId: v.string(),
	shardId: v.string(),
});

const subscriptionShardStateSchema = v.object({
	refs: v.array(entrySchema),
});

const grantRevokeInputSchema = v.object({
	actorId: v.string(),
	ref: entrySchema,
});

// ── Channel factory ────────────────────────────────────────────────────

type SubscriptionShardDefs = {
	readonly singletons: Record<never, never>;
	readonly perResource: { readonly subscription: SubscriptionShardState };
};

/**
 * The built-in subscriptions channel. `Kind` is widened to the union
 * `"durable" | "ephemeral"` because the factory returns the same shape
 * regardless of how the caller configured persistence — the narrow
 * kind isn't useful downstream (`engine().channel(...)` accepts either).
 *
 * TODO(proper fix): if a narrower `Kind` ever becomes useful, restructure
 * `ChannelBuilder` so the `Kind` type parameter does NOT appear in every
 * method's return type. Right now `shardPerResource`, `operation`,
 * `serverImpl`, etc. all return `ChannelBuilder<Kind, ...>`, which means
 * instance unions like `Builder<"durable"> | Builder<"ephemeral">` fail
 * to produce a callable merged signature (TS2349 "not callable on
 * union"). The fix is to keep `Kind` on the channel's runtime data but
 * not re-mention it in method return types, so the builder's method
 * surface is kind-agnostic at the type level. Out of scope for now.
 */
export type SubscriptionsChannel = ChannelBuilder<
	"durable" | "ephemeral",
	"subscriptions",
	SubscriptionShardDefs,
	object
>;

export interface CreateSubscriptionsChannelOptions {
	readonly kind: "durable" | "ephemeral";
}

/**
 * Build the engine-managed `subscriptions` channel.
 *
 * Declares one per-resource shard (`subscription`, keyed by actorId) and
 * two operations — `grant` and `revoke` — that mutate an actor's ref
 * set. Both ops are `serverOnly`: the pipeline rejects any non-server
 * submission before running validation or apply, so clients cannot call
 * them directly. The apply functions are idempotent — granting an
 * existing ref or revoking a missing ref is a no-op.
 *
 * Add to both the server-side and client-side engine:
 *
 * ```ts
 * import { createSubscriptionsChannel } from "@kiojs/shared"
 * export const subscriptionsChannel = createSubscriptionsChannel({ kind: "ephemeral" })
 * ```
 */
export function createSubscriptionsChannel(
	options: CreateSubscriptionsChannelOptions,
): SubscriptionsChannel {
	// Call createChannelBuilder with the union kind directly — this produces
	// ONE builder instance typed `ChannelBuilder<"durable" | "ephemeral", ...>`
	// rather than a union of two distinct builder instances. Method calls
	// then resolve against one signature and the chain types normally.
	// (See the SubscriptionsChannel TODO above for the deeper fix.)
	return createChannelBuilder(options.kind, SUBSCRIPTIONS_CHANNEL_NAME)
		.shardPerResource("subscription", subscriptionShardStateSchema, {
			// Materialize a fresh empty ref set the first time a given actor's
			// shard is touched — grant/revoke apply can then treat `refs` as
			// always-present and never needs to initialize it itself.
			defaultState: { refs: [] },
		})
		.operation("grant", {
			execution: "confirmed",
			versionChecked: true,
			deduplicate: false,
			serverOnly: true,
			input: grantRevokeInputSchema,
			scope: (input) => [shard.ref("subscription", input.actorId)],
		})
		.serverImpl("grant", {
			apply({ subscription }, input) {
				const current = subscription(input.actorId);
				const exists = current.refs.some(
					(r) =>
						r.channelId === input.ref.channelId &&
						r.shardId === input.ref.shardId,
				);
				if (!exists) {
					current.refs.push(input.ref);
				}
			},
		})
		.operation("revoke", {
			execution: "confirmed",
			versionChecked: true,
			deduplicate: false,
			serverOnly: true,
			input: grantRevokeInputSchema,
			scope: (input) => [shard.ref("subscription", input.actorId)],
		})
		.serverImpl("revoke", {
			apply({ subscription }, input) {
				const current = subscription(input.actorId);
				const idx = current.refs.findIndex(
					(r) =>
						r.channelId === input.ref.channelId &&
						r.shardId === input.ref.shardId,
				);
				if (idx !== -1) {
					current.refs.splice(idx, 1);
				}
			},
		});
}
