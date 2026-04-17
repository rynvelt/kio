import type { BaseActor } from "@kiojs/shared";
import type { PipelineResult } from "./pipeline";
import type { AfterCommitHandler, AfterCommitSubmitFn } from "./server";

const DEFAULT_MAX_DEPTH = 10;

/**
 * Collection of registered afterCommit hooks, indexed by (channelName, operationName).
 * Owns the depth-limit invariant for re-entrant submits from within hooks.
 *
 * Callers supply the `submit` function per invocation — the hooks collection
 * doesn't know about channels, the server actor, or op-id generation.
 */
export class AfterCommitHooks<TChannels extends object = object> {
	private readonly hooks = new Map<
		string,
		Map<string, AfterCommitHandler<unknown, TChannels>[]>
	>();
	private readonly maxDepth: number;

	constructor(maxDepth: number = DEFAULT_MAX_DEPTH) {
		this.maxDepth = maxDepth;
	}

	/** Register a handler for (channelName, operationName). Handlers run in registration order. */
	register(
		channelName: string,
		operationName: string,
		handler: AfterCommitHandler<unknown, TChannels>,
	): void {
		let channelHooks = this.hooks.get(channelName);
		if (!channelHooks) {
			channelHooks = new Map();
			this.hooks.set(channelName, channelHooks);
		}
		let opHooks = channelHooks.get(operationName);
		if (!opHooks) {
			opHooks = [];
			channelHooks.set(operationName, opHooks);
		}
		opHooks.push(handler);
	}

	/**
	 * Invoke all handlers registered for (channelName, result.operationName), in order.
	 * Resolves when every handler has settled. Throws if `depth >= maxDepth` and at
	 * least one handler exists for this (channel, op).
	 */
	async run(
		channelName: string,
		result: PipelineResult & { status: "acknowledged" },
		actor: BaseActor,
		input: unknown,
		depth: number,
		submit: AfterCommitSubmitFn<TChannels>,
	): Promise<void> {
		const handlers = this.hooks.get(channelName)?.get(result.operationName);
		if (!handlers || handlers.length === 0) return;

		if (depth >= this.maxDepth) {
			throw new Error(
				`afterCommit depth limit exceeded (${String(this.maxDepth)}) — possible infinite loop`,
			);
		}

		for (const handler of handlers) {
			await handler({
				operationName: result.operationName,
				input,
				actor,
				opId: result.opId,
				newState: result.newState,
				submit,
			});
		}
	}
}
