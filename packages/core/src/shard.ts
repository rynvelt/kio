/** Reference to a specific shard instance */
export interface ShardRef {
	readonly channelId: string;
	readonly shardId: string;
}

/** Create a shard reference */
export function ref(shardType: string, resourceId?: string): ShardRef {
	return {
		channelId: "", // filled in by engine at runtime
		shardId: resourceId ? `${shardType}:${resourceId}` : shardType,
	};
}

export const shard = { ref } as const;
