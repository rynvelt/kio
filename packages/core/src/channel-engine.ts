import type { CausedBy } from "./broadcast";
import { BroadcastManager, type Subscriber } from "./broadcast";
import type { ChannelData } from "./channel";
import type { StateAdapter } from "./persistence";
import {
	type AuthorizeFn,
	type DeduplicationTracker,
	MemoryDeduplicationTracker,
	OperationPipeline,
	type PipelineResult,
	type Submission,
} from "./pipeline";
import { ShardStateManager } from "./shard-state-manager";

/** Configuration for a ChannelEngine */
export interface ChannelEngineConfig {
	readonly authorize?: AuthorizeFn;
	readonly deduplication?: DeduplicationTracker;
}

/**
 * Internal orchestrator for one channel.
 * Composes ShardStateManager + OperationPipeline + BroadcastManager.
 * Not exposed to consumers — used by createServer internally.
 */
export class ChannelEngine {
	private readonly stateManager: ShardStateManager;
	private readonly pipeline: OperationPipeline;
	private readonly broadcastManager: BroadcastManager;
	private readonly autoBroadcast: boolean;

	constructor(
		private readonly channelData: ChannelData,
		adapter: StateAdapter,
		config: ChannelEngineConfig = {},
	) {
		this.autoBroadcast = channelData.options.autoBroadcast ?? true;

		this.stateManager = new ShardStateManager(
			channelData.name,
			channelData.shardDefs,
			adapter,
		);

		this.pipeline = new OperationPipeline(channelData, this.stateManager, {
			authorize: config.authorize,
			deduplication: config.deduplication ?? new MemoryDeduplicationTracker(),
		});

		this.broadcastManager = new BroadcastManager(
			channelData.name,
			channelData.kind,
		);

		// Wire state manager → broadcast manager for dirty tracking
		this.stateManager.onChange((shardId) => {
			this.broadcastManager.onShardChanged(shardId);
		});
	}

	/** Submit an operation — runs pipeline, broadcasts on success if autoBroadcast */
	async submit(submission: Submission): Promise<PipelineResult> {
		const result = await this.pipeline.submit(submission);

		if (result.status === "acknowledged" && this.autoBroadcast) {
			const causedBy: CausedBy = {
				opId: result.opId,
				operation: result.operationName,
				actor: submission.actor.actorId,
			};

			this.broadcastManager.broadcastPatches(
				result.patchesByShard,
				result.shardVersions,
				causedBy,
			);
		}
		// For autoBroadcast: false, dirty tracking happens automatically
		// via the stateManager.onChange → broadcastManager.onShardChanged wiring

		return result;
	}

	/** Add a subscriber to receive broadcasts for specific shards */
	addSubscriber(subscriber: Subscriber, shardIds: readonly string[]): void {
		this.broadcastManager.addSubscriber(subscriber, shardIds);
	}

	/** Remove a subscriber */
	removeSubscriber(subscriberId: string): void {
		this.broadcastManager.removeSubscriber(subscriberId);
	}

	/** Add shard subscriptions for an existing subscriber */
	addShards(subscriberId: string, shardIds: readonly string[]): void {
		this.broadcastManager.addShards(subscriberId, shardIds);
	}

	/** Remove shard subscriptions for an existing subscriber */
	removeShards(subscriberId: string, shardIds: readonly string[]): void {
		this.broadcastManager.removeShards(subscriberId, shardIds);
	}

	/** Flush dirty shards for autoBroadcast: false channels */
	broadcastDirtyShards(shardIds?: readonly string[]): void {
		this.broadcastManager.broadcastDirtyShards(
			(shardId) => this.stateManager.getCached(shardId),
			shardIds,
		);
	}

	/** Load shard states for initial sync. Returns shardId → { state, version }. */
	async loadShardStates(
		shardIds: readonly string[],
	): Promise<Map<string, { state: unknown; version: number }>> {
		const refs = shardIds.map((id) => {
			const parts = id.split(":");
			return { shardType: parts[0] ?? id, shardId: id };
		});
		const loaded = await this.stateManager.loadShards(refs);
		const result = new Map<string, { state: unknown; version: number }>();
		for (const [shardId, cached] of loaded) {
			if (cached.state !== undefined) {
				result.set(shardId, { state: cached.state, version: cached.version });
			}
		}
		return result;
	}

	get name(): string {
		return this.channelData.name;
	}

	get kind(): "durable" | "ephemeral" {
		return this.channelData.kind;
	}
}
