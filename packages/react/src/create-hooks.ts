import type { ClientSubscriptionMethods } from "@kiojs/client";
import type {
	BaseActor,
	ChannelBuilder,
	EngineBuilder,
	InferChannels,
	InferSubscriptions,
	OpMeta,
	ShardState,
	SubmitResult,
	SubscriptionShardState,
	SubscriptionsConfig,
} from "@kiojs/shared";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useKioClientInternal } from "./provider";

/** Extract shard defs from a ChannelBuilder */
type ExtractShardDefs<Ch> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer D, infer _O> ? D : never;

/** All singleton shard names for a channel */
type SingletonShardNames<Ch> = string &
	keyof ExtractShardDefs<Ch>["singletons"];

/** All per-resource shard names for a channel */
type PerResourceShardNames<Ch> = string &
	keyof ExtractShardDefs<Ch>["perResource"];

/** State type for a singleton shard */
type SingletonState<
	Ch,
	Name extends string,
> = Name extends keyof ExtractShardDefs<Ch>["singletons"]
	? ExtractShardDefs<Ch>["singletons"][Name]
	: never;

/** State type for a per-resource shard */
type PerResourceState<
	Ch,
	Name extends string,
> = Name extends keyof ExtractShardDefs<Ch>["perResource"]
	? ExtractShardDefs<Ch>["perResource"][Name]
	: never;

/** Extract operation names from a ChannelBuilder's Ops type */
type OperationNames<Ch> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? string & keyof Ops
		: never;

/** Extract input type for a specific operation */
type OperationInput<Ch, OpName extends string> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? OpName extends keyof Ops
			? Ops[OpName] extends OpMeta<infer _E, infer TInput, infer _Err, infer _S>
				? TInput
				: never
			: never
		: never;

/** Options accepted by the fallback-variant overloads of useShardState. */
interface ShardStateOptions<T> {
	/**
	 * Value returned as `state` whenever `syncStatus` is `"loading"` or
	 * `"unavailable"`. When set, the returned `state` is never null and the
	 * consumer can read it without narrowing on `syncStatus`.
	 */
	readonly fallback: T;
}

/** Hooks always available from createKioHooks. */
interface BaseHooks<TChannels extends object> {
	useShardState: {
		<
			CName extends string & keyof TChannels,
			SName extends SingletonShardNames<TChannels[CName]>,
		>(
			channelName: CName,
			shardId: SName,
		): ShardState<SingletonState<TChannels[CName], SName>>;
		<
			CName extends string & keyof TChannels,
			SName extends SingletonShardNames<TChannels[CName]>,
			TState extends SingletonState<TChannels[CName], SName>,
		>(
			channelName: CName,
			shardId: SName,
			opts: ShardStateOptions<TState>,
		): ShardState<TState, TState>;
		<
			CName extends string & keyof TChannels,
			SName extends PerResourceShardNames<TChannels[CName]>,
		>(
			channelName: CName,
			shardType: SName,
			resourceId: string,
		): ShardState<PerResourceState<TChannels[CName], SName>>;
		<
			CName extends string & keyof TChannels,
			SName extends PerResourceShardNames<TChannels[CName]>,
			TState extends PerResourceState<TChannels[CName], SName>,
		>(
			channelName: CName,
			shardType: SName,
			resourceId: string,
			opts: ShardStateOptions<TState>,
		): ShardState<TState, TState>;
	};
	useSubmit: <CName extends string & keyof TChannels>(
		channelName: CName,
	) => <OpName extends OperationNames<TChannels[CName]>>(
		operationName: OpName,
		input: OperationInput<TChannels[CName], OpName>,
	) => Promise<SubmitResult>;
}

/** Hook available only when the engine opted into subscriptions. */
interface SubscriptionHooks {
	useMySubscriptions: () => ShardState<SubscriptionShardState>;
}

// biome-ignore lint/complexity/noBannedTypes: empty intersection neutral element
type EmptyHooks = {};

/**
 * Create typed React hooks from a client engine builder.
 *
 * Always returns `useShardState` (singleton + per-resource overloads) and
 * `useSubmit` (typed operation names and inputs). When the engine has
 * `subscriptions: { kind }` configured, also returns `useMySubscriptions`
 * for observing the current actor's subscription shard.
 *
 * The engine is passed as a value (not just a type) so the factory can
 * inspect `~subscriptions` at runtime and attach `useMySubscriptions`
 * only when relevant — the returned object literally has no such property
 * when subscriptions are disabled.
 */
export function createKioHooks<
	TEngine extends EngineBuilder<
		object,
		BaseActor,
		SubscriptionsConfig | undefined
	>,
>(
	engine: TEngine,
): BaseHooks<InferChannels<TEngine>> &
	(InferSubscriptions<TEngine> extends SubscriptionsConfig
		? SubscriptionHooks
		: EmptyHooks) {
	type TChannels = InferChannels<TEngine>;

	/** Subscribe to a singleton shard's state. */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends SingletonShardNames<TChannels[CName]>,
	>(
		channelName: CName,
		shardId: SName,
	): ShardState<SingletonState<TChannels[CName], SName>>;

	/** Subscribe to a singleton shard with a fallback value. */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends SingletonShardNames<TChannels[CName]>,
		TState extends SingletonState<TChannels[CName], SName>,
	>(
		channelName: CName,
		shardId: SName,
		opts: ShardStateOptions<TState>,
	): ShardState<TState, TState>;

	/** Subscribe to a per-resource shard's state. */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends PerResourceShardNames<TChannels[CName]>,
	>(
		channelName: CName,
		shardType: SName,
		resourceId: string,
	): ShardState<PerResourceState<TChannels[CName], SName>>;

	/** Subscribe to a per-resource shard with a fallback value. */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends PerResourceShardNames<TChannels[CName]>,
		TState extends PerResourceState<TChannels[CName], SName>,
	>(
		channelName: CName,
		shardType: SName,
		resourceId: string,
		opts: ShardStateOptions<TState>,
	): ShardState<TState, TState>;

	function useShardState(
		channelName: string,
		shardTypeOrId: string,
		arg3?: string | ShardStateOptions<Record<string, unknown>>,
		arg4?: ShardStateOptions<Record<string, unknown>>,
	): ShardState<Record<string, unknown>, Record<string, unknown> | null> {
		const client = useKioClientInternal();

		const resourceId = typeof arg3 === "string" ? arg3 : undefined;
		const opts = typeof arg3 === "object" ? arg3 : arg4;
		const fallback = opts?.fallback;

		const shardId =
			resourceId !== undefined
				? `${shardTypeOrId}:${resourceId}`
				: shardTypeOrId;

		const ch = client.channel(channelName);

		const subscribe = useCallback(
			(onStoreChange: () => void) =>
				ch.subscribeToShard(shardId, onStoreChange),
			[ch, shardId],
		);

		const getSnapshot = useCallback(
			() => ch.shardState(shardId),
			[ch, shardId],
		);

		const raw = useSyncExternalStore(subscribe, getSnapshot);

		return useMemo(() => {
			if (fallback === undefined) return raw;
			if (raw.syncStatus === "loading" || raw.syncStatus === "unavailable") {
				return { syncStatus: raw.syncStatus, state: fallback, pending: null };
			}
			return raw;
		}, [raw, fallback]);
	}

	/**
	 * Returns a typed submit function for a channel.
	 */
	function useSubmit<CName extends string & keyof TChannels>(
		channelName: CName,
	): <OpName extends OperationNames<TChannels[CName]>>(
		operationName: OpName,
		input: OperationInput<TChannels[CName], OpName>,
	) => Promise<SubmitResult> {
		const client = useKioClientInternal();

		return useCallback(
			(operationName: string, input: unknown) =>
				client
					.channel(channelName)
					.submit(operationName as never, input as never),
			[client, channelName],
		) as never;
	}

	/**
	 * Subscribe to the current actor's subscription shard. Returns a
	 * ShardState that transitions from "loading" (pre-welcome) through
	 * "latest" as the server delivers the actor's ref set.
	 */
	function useMySubscriptions(): ShardState<SubscriptionShardState> {
		// The client always has the methods at runtime when this hook is
		// reachable — createKioHooks only attaches useMySubscriptions when the
		// engine has subscriptions configured, and in that case createClient
		// also attaches the methods. Narrow cast to the minimum needed.
		const client =
			useKioClientInternal() as unknown as ClientSubscriptionMethods;

		const subscribe = useCallback(
			(onStoreChange: () => void) =>
				client.subscribeToMySubscriptions(onStoreChange),
			[client],
		);

		const getSnapshot = useCallback(() => client.mySubscriptions(), [client]);

		return useSyncExternalStore(subscribe, getSnapshot);
	}

	// Build the base hooks; attach useMySubscriptions only when the engine
	// actually has subscriptions enabled — mirrors server/client behavior.
	const base: BaseHooks<TChannels> = { useShardState, useSubmit };
	if (engine["~subscriptions"]) {
		const subsHooks: SubscriptionHooks = { useMySubscriptions };
		Object.assign(base, subsHooks);
	}

	return base as BaseHooks<TChannels> &
		(InferSubscriptions<TEngine> extends SubscriptionsConfig
			? SubscriptionHooks
			: EmptyHooks);
}
