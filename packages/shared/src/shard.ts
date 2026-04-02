/** Reference to a specific shard instance, carrying the shard type name */
export interface ShardRef<TShardType extends string = string> {
	readonly shardType: TShardType;
	readonly shardId: string;
}

/** Create a typed shard reference */
export function ref<T extends string>(
	shardType: T,
	resourceId?: string,
): ShardRef<T> {
	return {
		shardType,
		shardId: resourceId ? `${shardType}:${resourceId}` : shardType,
	};
}

/** Extract shard type names from an array of ShardRefs */
export type ExtractShardTypes<Refs extends readonly ShardRef[]> =
	Refs[number]["shardType"];

export const shard = { ref } as const;
