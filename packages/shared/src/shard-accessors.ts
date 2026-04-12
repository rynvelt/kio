import type { ShardDefinition } from "./channel";
import type { ShardRef } from "./shard";

/**
 * Build shard accessors from a root object keyed by shard ID.
 * Singleton shards → direct property access: `accessors.world`
 * Per-resource shards → function: `accessors.seat(resourceId)`
 *
 * Used by both server (pipeline) and client (optimistic apply).
 */
export function buildShardAccessors(
	root: Record<string, unknown>,
	scopedRefs: readonly ShardRef[],
	shardDefs: ReadonlyMap<string, ShardDefinition>,
): Record<string, unknown> {
	const accessors: Record<string, unknown> = {};
	const scopedShardTypes = new Set(scopedRefs.map((r) => r.shardType));

	for (const shardType of scopedShardTypes) {
		const def = shardDefs.get(shardType);
		if (!def) continue;

		if (def.kind === "singleton") {
			Object.defineProperty(accessors, shardType, {
				get: () => {
					if (root[shardType] === undefined) {
						root[shardType] = {};
					}
					return root[shardType];
				},
				enumerable: true,
			});
		} else {
			accessors[shardType] = (resourceId: string) => {
				const shardId = `${shardType}:${resourceId}`;
				if (root[shardId] === undefined) {
					root[shardId] = {};
				}
				return root[shardId];
			};
		}
	}

	return accessors;
}
