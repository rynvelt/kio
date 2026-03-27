import type { Patch } from "immer";
import type {
	ChannelData,
	OperationDefinition,
	ServerImplDefinition,
} from "./channel";
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
	readonly opId?: string;
}

/** Pipeline result — mirrors SubmitResult but with patches for broadcasting */
export type PipelineResult =
	| {
			readonly status: "acknowledged";
			readonly operationName: string;
			readonly shardVersions: ReadonlyMap<string, number>;
			readonly patchesByShard: ReadonlyMap<string, readonly Patch[]>;
	  }
	| {
			readonly status: "rejected";
			readonly code: string;
			readonly message: string;
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
		if (opDef.deduplicate && opId) {
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

		// 3. Authorization
		if (this.config.authorize) {
			const authorized = await this.config.authorize(
				actor,
				operationName,
				this.channelData.name,
			);
			if (!authorized) {
				return {
					status: "rejected",
					code: "UNAUTHORIZED",
					message: "Not authorized to perform this operation",
				};
			}
		}

		// 4. Resolve scope
		const ctx = { actor, channelId: this.channelData.name };
		const scopeRefs = opDef.scope(validatedInput, ctx);

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
			const readAccessors = this.stateManager.buildAccessors(
				composedRoot,
				scopeRefs,
			);
			serverResult = serverImpl.compute(readAccessors, validatedInput, ctx);
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

		const finalServerResult = serverResult;
		const { newRoot, patchesByShard } = this.stateManager.applyMutation(
			composedRoot,
			scopeRefs,
			(accessors) => {
				applyFn(accessors, validatedInput, finalServerResult, ctx);
			},
		);

		// 9. Persist (durable channels only)
		if (this.channelData.kind === "durable") {
			const persistResult = await this.stateManager.persist(
				loadedShards,
				newRoot,
			);

			if (!persistResult.success) {
				return {
					status: "rejected",
					code: "VERSION_CONFLICT",
					message: `Version conflict on shard "${persistResult.failedShardId}"`,
				};
			}

			// 10. Track deduplication after successful persist
			if (opDef.deduplicate && opId) {
				this.config.deduplication?.add(opId);
			}

			return {
				status: "acknowledged",
				operationName,
				shardVersions: persistResult.versions,
				patchesByShard,
			};
		}

		// Ephemeral channels: update cache directly, no persistence
		for (const [shardId] of loadedShards) {
			const newState = newRoot[shardId];
			const cached = this.stateManager.getCached(shardId);
			const newVersion = (cached?.version ?? 0) + 1;
			this.stateManager.setCached(shardId, newState, newVersion);
		}

		if (opDef.deduplicate && opId) {
			this.config.deduplication?.add(opId);
		}

		const ephemeralVersions = new Map<string, number>();
		for (const [shardId] of loadedShards) {
			const cached = this.stateManager.getCached(shardId);
			if (cached) ephemeralVersions.set(shardId, cached.version);
		}

		return {
			status: "acknowledged",
			operationName,
			shardVersions: ephemeralVersions,
			patchesByShard,
		};
	}

	private runValidate(
		serverImpl: ServerImplDefinition,
		composedRoot: Record<string, unknown>,
		scopeRefs: readonly import("./shard").ShardRef[],
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
