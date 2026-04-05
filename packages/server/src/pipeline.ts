import type {
	ChannelData,
	OperationDefinition,
	ServerImplDefinition,
	ShardRef,
} from "@kio/shared";
import type { Patch } from "immer";
import type { ShardStateManager } from "./shard-state-manager";

/** Actor identity for operation context */
export interface Actor {
	readonly actorId: string;
}

export const KIO_SERVER_ACTOR: Actor = { actorId: "__kio:server__" };

/** Submission from a client or server-as-actor */
export interface Submission {
	readonly operationName: string;
	readonly input: unknown;
	readonly actor: Actor;
	readonly opId: string;
}

/** Pipeline result — mirrors SubmitResult but with patches for broadcasting */
export type PipelineResult =
	| {
			readonly status: "acknowledged";
			readonly opId: string;
			readonly operationName: string;
			readonly shardVersions: ReadonlyMap<string, number>;
			readonly patchesByShard: ReadonlyMap<string, readonly Patch[]>;
	  }
	| {
			readonly status: "rejected";
			readonly code: string;
			readonly message: string;
			/** Fresh shard state — included for VERSION_CONFLICT rejections */
			readonly shards?: ReadonlyArray<{
				readonly shardId: string;
				readonly version: number;
				readonly state: unknown;
			}>;
	  };

/** Rejection error thrown by validate's reject() callback */
class OperationRejection {
	constructor(
		readonly code: string,
		readonly message: string,
	) {}
}

/** Authorization hook */
export type AuthorizeFn = (
	actor: Actor,
	operationName: string,
	channelId: string,
	shardRefs: readonly ShardRef[],
) => boolean | Promise<boolean>;

/** Deduplication tracker */
export interface DeduplicationTracker {
	has(opId: string): boolean;
	add(opId: string): void;
}

/** In-memory deduplication tracker */
export class MemoryDeduplicationTracker implements DeduplicationTracker {
	private readonly seen = new Set<string>();

	has(opId: string): boolean {
		return this.seen.has(opId);
	}

	add(opId: string): void {
		this.seen.add(opId);
	}
}

/** Configuration for the pipeline */
export interface PipelineConfig {
	readonly authorize?: AuthorizeFn;
	readonly deduplication?: DeduplicationTracker;
}

/** Runs the server-side operation pipeline */
export class OperationPipeline {
	constructor(
		private readonly channelData: ChannelData,
		private readonly stateManager: ShardStateManager,
		private readonly config: PipelineConfig = {},
	) {}

	async submit(submission: Submission): Promise<PipelineResult> {
		try {
			return await this.run(submission);
		} catch {
			return {
				status: "rejected",
				code: "INTERNAL_ERROR",
				message: "An unexpected error occurred",
			};
		}
	}

	private async run(submission: Submission): Promise<PipelineResult> {
		const { operationName, input, actor, opId } = submission;

		const opDef = this.channelData.operations.get(operationName);
		if (!opDef) {
			return {
				status: "rejected",
				code: "INVALID_OPERATION",
				message: `Operation "${operationName}" is not defined`,
			};
		}

		// 1. Deduplication
		if (opDef.deduplicate) {
			if (this.config.deduplication?.has(opId)) {
				return {
					status: "rejected",
					code: "DUPLICATE_OPERATION",
					message: `Operation ${opId} already processed`,
				};
			}
		}

		// 2. Input validation via StandardSchema
		const inputResult = await opDef.inputSchema["~standard"].validate(input);
		if ("issues" in inputResult && inputResult.issues) {
			return {
				status: "rejected",
				code: "INVALID_INPUT",
				message: inputResult.issues.map((i) => i.message).join("; "),
			};
		}
		const validatedInput = "value" in inputResult ? inputResult.value : input;

		// 3. Resolve scope
		const ctx = { actor, channelId: this.channelData.name };
		const scopeRefs = opDef.scope(validatedInput, ctx);

		// 4. Authorization
		if (this.config.authorize) {
			const authorized = await this.config.authorize(
				actor,
				operationName,
				this.channelData.name,
				scopeRefs,
			);
			if (!authorized) {
				return {
					status: "rejected",
					code: "UNAUTHORIZED",
					message: "Not authorized to perform this operation",
				};
			}
		}

		// 5. Load scoped shards
		const loadedShards = await this.stateManager.loadShards(scopeRefs);
		const composedRoot = this.stateManager.buildComposedRoot(loadedShards);

		// 6. Validate (server impl)
		const serverImpl = this.channelData.serverImpls.get(operationName);
		if (serverImpl?.validate) {
			const rejection = this.runValidate(
				serverImpl,
				composedRoot,
				scopeRefs,
				validatedInput,
				ctx,
			);
			if (rejection) {
				return {
					status: "rejected",
					code: rejection.code,
					message: rejection.message,
				};
			}
		}

		// 7. Compute (server impl, computed ops only)
		let serverResult: unknown;
		if (opDef.execution === "computed" && serverImpl?.compute) {
			try {
				const readAccessors = this.stateManager.buildAccessors(
					composedRoot,
					scopeRefs,
				);
				serverResult = serverImpl.compute(readAccessors, validatedInput, ctx);
			} catch {
				return {
					status: "rejected",
					code: "INTERNAL_ERROR",
					message: "An unexpected error occurred",
				};
			}
		}

		// 8. Apply — determine which apply function to use
		const applyFn = this.resolveApplyFn(opDef, serverImpl);
		if (!applyFn) {
			return {
				status: "rejected",
				code: "INTERNAL_ERROR",
				message: `No apply function for operation "${operationName}"`,
			};
		}

		let newRoot: Record<string, unknown>;
		let patchesByShard: Map<string, import("immer").Patch[]>;
		const finalServerResult = serverResult;
		try {
			const result = this.stateManager.applyMutation(
				composedRoot,
				scopeRefs,
				(accessors) => {
					applyFn(accessors, validatedInput, finalServerResult, ctx);
				},
			);
			newRoot = result.newRoot;
			patchesByShard = result.patchesByShard;
		} catch {
			return {
				status: "rejected",
				code: "INTERNAL_ERROR",
				message: "An unexpected error occurred",
			};
		}

		// Only persist shards that were actually changed
		const dirtyShardIds = [...patchesByShard.keys()];

		// 9. Persist (durable channels only)
		if (this.channelData.kind === "durable") {
			let versions: Map<string, number>;

			if (opDef.versionChecked) {
				// Filter loadedShards to only dirty ones for CAS
				const dirtyShards = new Map(
					[...loadedShards.entries()].filter(([id]) =>
						dirtyShardIds.includes(id),
					),
				);
				const persistResult = await this.stateManager.persist(
					dirtyShards,
					newRoot,
				);

				if (!persistResult.success) {
					// Reload fresh state for dirty shards so clients can evaluate canRetry
					const freshShards = await this.stateManager.loadShards(
						scopeRefs.filter((ref) => dirtyShardIds.includes(ref.shardId)),
					);
					const shards = [...freshShards.entries()].map(
						([shardId, cached]) => ({
							shardId,
							version: cached.version,
							state: cached.state,
						}),
					);

					return {
						status: "rejected",
						code: "VERSION_CONFLICT",
						message: `Version conflict on shard "${persistResult.failedShardId}"`,
						shards,
					};
				}
				versions = persistResult.versions;
			} else {
				// Unconditional write — no version check
				const result = await this.stateManager.persistUnconditional(
					dirtyShardIds,
					newRoot,
				);
				versions = result.versions;
			}

			if (opDef.deduplicate) {
				this.config.deduplication?.add(opId);
			}

			return {
				status: "acknowledged",
				opId,
				operationName,
				shardVersions: versions,
				patchesByShard,
			};
		}

		// Ephemeral channels: update cache directly, no persistence
		const ephemeralVersions = new Map<string, number>();
		for (const shardId of dirtyShardIds) {
			const newState = newRoot[shardId];
			const cached = this.stateManager.getCached(shardId);
			const newVersion = (cached?.version ?? 0) + 1;
			this.stateManager.setCached(shardId, newState, newVersion);
			ephemeralVersions.set(shardId, newVersion);
		}

		if (opDef.deduplicate) {
			this.config.deduplication?.add(opId);
		}

		return {
			status: "acknowledged",
			opId,
			operationName,
			shardVersions: ephemeralVersions,
			patchesByShard,
		};
	}

	private runValidate(
		serverImpl: ServerImplDefinition,
		composedRoot: Record<string, unknown>,
		scopeRefs: readonly ShardRef[],
		input: unknown,
		ctx: { actor: Actor; channelId: string },
	): OperationRejection | undefined {
		const accessors = this.stateManager.buildAccessors(composedRoot, scopeRefs);
		const reject = (code: string, message: string): never => {
			throw new OperationRejection(code, message);
		};

		try {
			serverImpl.validate?.(accessors, input, ctx, { reject });
			return undefined;
		} catch (e) {
			if (e instanceof OperationRejection) {
				return e;
			}
			throw e;
		}
	}

	private resolveApplyFn(
		opDef: OperationDefinition,
		serverImpl: ServerImplDefinition | undefined,
	): OperationDefinition["apply"] {
		if (opDef.execution === "optimistic") {
			return opDef.apply;
		}
		return serverImpl?.apply;
	}
}
