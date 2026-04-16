import type {
	BaseActor,
	SubscriptionRef,
	SubscriptionShardState,
} from "@kio/shared";
import { SUBSCRIPTIONS_CHANNEL_NAME } from "@kio/shared";
import type { ChannelRuntime } from "./channel-runtime";
import type { PipelineResult, Submission } from "./pipeline";

/**
 * Dependencies for SubscriptionResolver. The resolver answers "given an
 * actor, which shards (grouped by channel) should this connection
 * subscribe to?" — reading the subscription shard is the authoritative
 * source, with first-connect bootstrap via `defaultSubscriptions`.
 */
export interface SubscriptionResolverDeps<TActor extends BaseActor> {
	/** Pointer to the subscriptions ChannelRuntime, or undefined if the
	 * engine hasn't opted into subscriptions. */
	readonly subsChannel: ChannelRuntime | undefined;
	/** Server-as-actor value used for bootstrap grant submissions. */
	readonly serverActor: BaseActor;
	/** Submit into the pipeline (same signature as TransportProtocol uses). */
	readonly submit: (
		channelName: string,
		submission: Submission,
	) => Promise<PipelineResult>;
	/** Consumer-provided seed refs for a new actor's first connect. */
	readonly defaultSubscriptions?: (actor: TActor) => readonly SubscriptionRef[];
}

/**
 * Resolves the shards a connection should subscribe to at connect time.
 *
 * Flow when the subscriptions channel is registered:
 * 1. Load the actor's subscription shard.
 * 2. If version === 0 (first-ever connect), seed via
 *    `defaultSubscriptions(actor)` by submitting a grant per ref as
 *    server-as-actor. Re-read after.
 * 3. Auto-append the actor's own subscription shard ref so the client can
 *    observe its access set via `mySubscriptions()`.
 * 4. Return refs grouped by channel.
 *
 * When subscriptions aren't enabled, returns an empty map — connections
 * subscribe to nothing, and consumers must opt in to get any
 * subscriptions at all.
 */
export class SubscriptionResolver<TActor extends BaseActor> {
	private bootstrapOpCounter = 0;

	constructor(private readonly deps: SubscriptionResolverDeps<TActor>) {}

	async resolveForActor(
		actor: TActor,
	): Promise<ReadonlyMap<string, readonly string[]>> {
		const refs = await this.collectRefs(actor);
		return this.groupByChannel(refs);
	}

	private async collectRefs(
		actor: TActor,
	): Promise<readonly SubscriptionRef[]> {
		const { subsChannel } = this.deps;
		if (!subsChannel) return [];

		const actorShardId = `subscription:${actor.actorId}`;

		// Load current state. For ephemeral channels this pulls from cache
		// or initializes from defaultState; for durable it hits the adapter.
		let state = await this.loadSubscriptionState(actorShardId);
		const isFirstConnect = state.version === 0;

		if (isFirstConnect) {
			await this.bootstrap(actor);
			state = await this.loadSubscriptionState(actorShardId);
		}

		// Always include the actor's own subscription shard so the client
		// can observe its own access set. Dedup in case a consumer (oddly)
		// declared it in defaultSubscriptions too.
		const ownRef: SubscriptionRef = {
			channelId: SUBSCRIPTIONS_CHANNEL_NAME,
			shardId: actorShardId,
		};
		const hasOwn = state.refs.some(
			(r) => r.channelId === ownRef.channelId && r.shardId === ownRef.shardId,
		);
		return hasOwn ? state.refs : [...state.refs, ownRef];
	}

	private async loadSubscriptionState(
		actorShardId: string,
	): Promise<{ refs: readonly SubscriptionRef[]; version: number }> {
		const subsChannel = this.deps.subsChannel;
		if (!subsChannel) return { refs: [], version: 0 };

		const loaded = await subsChannel.loadShardStates([actorShardId]);
		const cached = loaded.get(actorShardId);
		if (!cached) return { refs: [], version: 0 };
		const typed = cached.state as SubscriptionShardState | undefined;
		return { refs: typed?.refs ?? [], version: cached.version };
	}

	private async bootstrap(actor: TActor): Promise<void> {
		const seeds = this.deps.defaultSubscriptions?.(actor) ?? [];
		for (const ref of seeds) {
			await this.deps.submit(SUBSCRIPTIONS_CHANNEL_NAME, {
				operationName: "grant",
				input: { actorId: actor.actorId, ref },
				actor: this.deps.serverActor,
				opId: `bootstrap:${String(this.bootstrapOpCounter++)}`,
			});
		}
	}

	private groupByChannel(
		refs: readonly SubscriptionRef[],
	): ReadonlyMap<string, readonly string[]> {
		const byChannel = new Map<string, string[]>();
		for (const ref of refs) {
			let list = byChannel.get(ref.channelId);
			if (!list) {
				list = [];
				byChannel.set(ref.channelId, list);
			}
			list.push(ref.shardId);
		}
		return byChannel;
	}
}
