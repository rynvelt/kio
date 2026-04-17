import type {
	CasMultiResult,
	CasResult,
	PersistedShard,
	StateAdapter,
} from "@kiojs/server";
import type { PrismaClient } from "./generated/client";

/** CAS failure info thrown inside transactions to trigger rollback */
interface CasFailure {
	readonly _casFail: true;
	readonly failedShardId: string;
	readonly currentVersion: number;
	readonly currentState: unknown;
}

function isCasFailure(err: unknown): err is CasFailure {
	return (
		typeof err === "object" &&
		err !== null &&
		"_casFail" in err &&
		(err as CasFailure)._casFail === true
	);
}

/**
 * Prisma-based persistence adapter for Kio.
 *
 * Uses a ShardState table with (channelId, shardId) composite key.
 * Compare-and-swap uses version-conditional updates.
 * Multi-shard CAS uses interactive transactions for atomicity.
 *
 * Requires the ShardState model from the Kio Prisma schema.
 */
export class PrismaStateAdapter implements StateAdapter {
	constructor(private readonly prisma: PrismaClient) {}

	async load(
		channelId: string,
		shardId: string,
	): Promise<PersistedShard | undefined> {
		const row = await this.prisma.shardState.findUnique({
			where: { channelId_shardId: { channelId, shardId } },
		});
		if (!row) return undefined;
		return { state: row.state, version: row.version };
	}

	async set(
		channelId: string,
		shardId: string,
		newState: unknown,
	): Promise<{ version: number }> {
		const state = newState as Parameters<typeof JSON.stringify>[0];
		const row = await this.prisma.shardState.upsert({
			where: { channelId_shardId: { channelId, shardId } },
			update: { state, version: { increment: 1 } },
			create: { channelId, shardId, state, version: 1 },
		});
		return { version: row.version };
	}

	async compareAndSwap(
		channelId: string,
		shardId: string,
		expectedVersion: number,
		newState: unknown,
	): Promise<CasResult> {
		const state = newState as Parameters<typeof JSON.stringify>[0];
		const result = await this.prisma.shardState.updateMany({
			where: { channelId, shardId, version: expectedVersion },
			data: { state, version: expectedVersion + 1 },
		});

		if (result.count === 1) {
			return { success: true, version: expectedVersion + 1 };
		}

		// Version mismatch — load current state
		const current = await this.prisma.shardState.findUnique({
			where: { channelId_shardId: { channelId, shardId } },
		});

		return {
			success: false,
			currentVersion: current?.version ?? 0,
			currentState: current?.state,
		};
	}

	async setMulti(
		operations: ReadonlyArray<{
			readonly channelId: string;
			readonly shardId: string;
			readonly newState: unknown;
		}>,
	): Promise<{ readonly versions: ReadonlyMap<string, number> }> {
		if (operations.length === 0) {
			return { versions: new Map() };
		}

		return await this.prisma.$transaction(async (tx) => {
			const versions = new Map<string, number>();
			for (const op of operations) {
				const state = op.newState as Parameters<typeof JSON.stringify>[0];
				const row = await tx.shardState.upsert({
					where: {
						channelId_shardId: {
							channelId: op.channelId,
							shardId: op.shardId,
						},
					},
					update: { state, version: { increment: 1 } },
					create: {
						channelId: op.channelId,
						shardId: op.shardId,
						state,
						version: 1,
					},
				});
				versions.set(op.shardId, row.version);
			}
			return { versions };
		});
	}

	async compareAndSwapMulti(
		operations: ReadonlyArray<{
			readonly channelId: string;
			readonly shardId: string;
			readonly expectedVersion: number;
			readonly newState: unknown;
		}>,
	): Promise<CasMultiResult> {
		if (operations.length === 0) {
			return { success: true, versions: new Map() };
		}

		try {
			return await this.prisma.$transaction(async (tx) => {
				const versions = new Map<string, number>();

				for (const op of operations) {
					const state = op.newState as Parameters<typeof JSON.stringify>[0];
					const result = await tx.shardState.updateMany({
						where: {
							channelId: op.channelId,
							shardId: op.shardId,
							version: op.expectedVersion,
						},
						data: { state, version: op.expectedVersion + 1 },
					});

					if (result.count !== 1) {
						const current = await tx.shardState.findUnique({
							where: {
								channelId_shardId: {
									channelId: op.channelId,
									shardId: op.shardId,
								},
							},
						});

						throw {
							_casFail: true,
							failedShardId: op.shardId,
							currentVersion: current?.version ?? 0,
							currentState: current?.state,
						} satisfies CasFailure;
					}

					versions.set(op.shardId, op.expectedVersion + 1);
				}

				return { success: true as const, versions };
			});
		} catch (err) {
			if (isCasFailure(err)) {
				return {
					success: false,
					failedShardId: err.failedShardId,
					currentVersion: err.currentVersion,
					currentState: err.currentState,
				};
			}
			throw err;
		}
	}
}
