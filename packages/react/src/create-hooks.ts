import type { Client } from "@kio/client";
import type {
	ChannelBuilder,
	OpMeta,
	ShardState,
	SubmitResult,
} from "@kio/shared";
import { useCallback, useSyncExternalStore } from "react";
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

/**
 * Create typed React hooks from a client engine builder.
 *
 * Returns a `useShardState` hook (for singletons and per-resource shards)
 * and a `useSubmit` hook (typed operation names and inputs).
 */
export function createKioHooks<TChannels extends object>() {
	/**
	 * Subscribe to a singleton shard's state.
	 */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends SingletonShardNames<TChannels[CName]>,
	>(
		channelName: CName,
		shardId: SName,
	): ShardState<SingletonState<TChannels[CName], SName>>;

	/**
	 * Subscribe to a per-resource shard's state.
	 */
	function useShardState<
		CName extends string & keyof TChannels,
		SName extends PerResourceShardNames<TChannels[CName]>,
	>(
		channelName: CName,
		shardType: SName,
		resourceId: string,
	): ShardState<PerResourceState<TChannels[CName], SName>>;

	function useShardState(
		channelName: string,
		shardTypeOrId: string,
		resourceId?: string,
	): ShardState<Record<string, unknown>> {
		const client = useKioClientInternal() as Client<TChannels>;
		const shardId =
			resourceId !== undefined
				? `${shardTypeOrId}:${resourceId}`
				: shardTypeOrId;

		const ch = (client as Client<Record<string, never>>).channel(
			channelName as never,
		);

		const subscribe = useCallback(
			(onStoreChange: () => void) =>
				ch.subscribeToShard(shardId, onStoreChange),
			[ch, shardId],
		);

		const getSnapshot = useCallback(
			() => ch.shardState(shardId),
			[ch, shardId],
		);

		return useSyncExternalStore(subscribe, getSnapshot);
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
		const client = useKioClientInternal() as Client<TChannels>;

		return useCallback(
			(operationName: string, input: unknown) =>
				(client as Client<Record<string, never>>)
					.channel(channelName as never)
					.submit(operationName as never, input as never),
			[client, channelName],
		) as never;
	}

	return { useShardState, useSubmit };
}
