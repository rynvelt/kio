import type {
	BaseActor,
	ChannelBuilder,
	EngineBuilder,
	ServerTransport,
	Subscriber,
} from "@kio/shared";
import { ActorRegistry } from "./actor-registry";
import { ChannelRuntime } from "./channel-runtime";
import type { StateAdapter } from "./persistence";
import type { AuthorizeFn, PipelineResult } from "./pipeline";
import { TransportProtocol } from "./transport-protocol";

// ── Types & interfaces ──────────────────────────────────────────────

/** Subscription entry: which channel and which shards */
export interface SubscriptionRef {
	readonly channelId: string;
	readonly shardIds: readonly string[];
}

/** Configuration for createServer — TActor is inferred from the engine builder */
export interface ServerConfig<TActor extends BaseActor = BaseActor> {
	readonly persistence: StateAdapter;
	readonly transport?: ServerTransport;
	readonly authorize?: AuthorizeFn;
	readonly defaultSubscriptions?: (actor: TActor) => readonly SubscriptionRef[];
	readonly onConnect?: (actor: TActor) => void;
	readonly onDisconnect?: (actor: TActor, reason: string) => void;
}

/** Extract operation names from a ChannelBuilder's Ops type */
type OperationNames<Ch> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? string & keyof Ops
		: never;

/** Extract input type for a specific operation on a channel */
type OperationInput<Ch, OpName extends string> =
	Ch extends ChannelBuilder<infer _K, infer _N, infer _D, infer Ops>
		? OpName extends keyof Ops
			? Ops[OpName] extends { _input: infer TInput }
				? TInput
				: never
			: never
		: never;

/** Typed server instance — channel names, operation names, and inputs are enforced */
export interface Server<TChannels extends object = object> {
	submit<
		CName extends string & keyof TChannels,
		OpName extends OperationNames<TChannels[CName]>,
	>(
		channelName: CName,
		operationName: OpName,
		input: OperationInput<TChannels[CName], OpName>,
	): Promise<PipelineResult>;

	broadcastDirtyShards(
		channelName: string & keyof TChannels,
		shardIds?: readonly string[],
	): void;

	addSubscriber(
		channelName: string & keyof TChannels,
		subscriber: Subscriber,
		shardIds: readonly string[],
	): void;

	removeSubscriber(
		channelName: string & keyof TChannels,
		subscriberId: string,
	): void;

	addTransportSubscriber(
		channelName: string & keyof TChannels,
		connectionId: string,
		shardIds: readonly string[],
	): void;

	removeTransportSubscriber(
		channelName: string & keyof TChannels,
		connectionId: string,
	): void;

	getChannel(channelName: string & keyof TChannels): ChannelRuntime | undefined;

	/** Register a hook that runs after an operation is successfully applied */
	afterApply<
		CName extends string & keyof TChannels,
		OpName extends OperationNames<TChannels[CName]>,
	>(
		channelName: CName,
		operationName: OpName,
		handler: AfterApplyHandler<
			OperationInput<TChannels[CName], OpName>,
			TChannels
		>,
	): void;
}

/** Submit function available inside afterApply — same signature as Server.submit */
type AfterApplySubmitFn<TChannels extends object> = <
	CName extends string & keyof TChannels,
	OpName extends OperationNames<TChannels[CName]>,
>(
	channelName: CName,
	operationName: OpName,
	input: OperationInput<TChannels[CName], OpName>,
) => Promise<PipelineResult>;

/** Context passed to afterApply handlers */
export interface AfterApplyContext<
	TInput = unknown,
	TChannels extends object = object,
> {
	readonly operationName: string;
	readonly input: TInput;
	readonly actor: BaseActor;
	readonly opId: string;
	/** Post-apply shard state keyed by shardId — captured during apply, not affected by concurrent operations */
	readonly newState: Readonly<Record<string, unknown>>;
	/** Submit another operation (depth-tracked to prevent infinite loops) */
	readonly submit: AfterApplySubmitFn<TChannels>;
}

/** Handler function for afterApply hooks */
export type AfterApplyHandler<
	TInput = unknown,
	TChannels extends object = object,
> = (ctx: AfterApplyContext<TInput, TChannels>) => void | Promise<void>;

// ── createServer ────────────────────────────────────────────────────

export function createServer<
	TChannels extends object,
	TActor extends BaseActor = BaseActor,
>(
	engineBuilder: EngineBuilder<TChannels, TActor>,
	config: ServerConfig<TActor>,
): Server<TChannels> {
	const channels = new Map<string, ChannelRuntime>();
	const { transport } = config;
	const serverActor: BaseActor = engineBuilder["~serverActor"] ?? {
		actorId: "__kio:server__",
	};

	// Setup: create channel runtimes
	for (const [name, channelData] of engineBuilder["~channels"]) {
		channels.set(
			name,
			new ChannelRuntime(channelData, config.persistence, {
				authorize: config.authorize,
				serverActorId: serverActor.actorId,
			}),
		);
	}

	const actorRegistry = new ActorRegistry<TActor>(
		engineBuilder["~actorSchema"],
	);

	function getChannelOrThrow(channelName: string): ChannelRuntime {
		const ch = channels.get(channelName);
		if (!ch) {
			throw new Error(`Channel "${channelName}" is not registered`);
		}
		return ch;
	}

	// ── afterApply hooks ────────────────────────────────────────────

	const MAX_AFTER_APPLY_DEPTH = 10;

	/** Map<channelName, Map<operationName, handler[]>> */
	const afterApplyHooks = new Map<
		string,
		Map<string, AfterApplyHandler<unknown, TChannels>[]>
	>();

	function registerAfterApply(
		channelName: string,
		operationName: string,
		handler: AfterApplyHandler<unknown, TChannels>,
	): void {
		let channelHooks = afterApplyHooks.get(channelName);
		if (!channelHooks) {
			channelHooks = new Map();
			afterApplyHooks.set(channelName, channelHooks);
		}
		let opHooks = channelHooks.get(operationName);
		if (!opHooks) {
			opHooks = [];
			channelHooks.set(operationName, opHooks);
		}
		opHooks.push(handler);
	}

	async function runAfterApplyHooks(
		channelName: string,
		result: PipelineResult & { status: "acknowledged" },
		actor: BaseActor,
		input: unknown,
		depth: number,
	): Promise<void> {
		const handlers = afterApplyHooks
			.get(channelName)
			?.get(result.operationName);
		if (!handlers || handlers.length === 0) return;

		if (depth >= MAX_AFTER_APPLY_DEPTH) {
			throw new Error(
				`afterApply depth limit exceeded (${String(MAX_AFTER_APPLY_DEPTH)}) — possible infinite loop`,
			);
		}

		const boundSubmit: AfterApplySubmitFn<TChannels> = (ch, op, submitInput) =>
			internalSubmit(
				ch as string,
				op as string,
				submitInput,
				serverActor,
				`server:${String(serverOpCounter++)}`,
				depth + 1,
			);

		for (const handler of handlers) {
			await handler({
				operationName: result.operationName,
				input,
				actor,
				opId: result.opId,
				newState: result.newState,
				submit: boundSubmit,
			});
		}
	}

	// ── Internal submit (shared by consumer API and transport protocol) ──

	let serverOpCounter = 0;

	async function internalSubmit(
		channelName: string,
		operationName: string,
		input: unknown,
		actor: BaseActor,
		opId: string,
		depth: number,
	): Promise<PipelineResult> {
		const ch = getChannelOrThrow(channelName);
		const result = await ch.submit({ operationName, input, actor, opId });
		if (result.status === "acknowledged") {
			await runAfterApplyHooks(channelName, result, actor, input, depth);
		}
		return result;
	}

	// ── Transport protocol (only when transport is configured) ──────

	const protocol = transport
		? new TransportProtocol<TActor>({
				transport,
				actorRegistry,
				channels,
				submit: (channelName, submission) =>
					getChannelOrThrow(channelName).submit(submission),
				runAfterApply: (channelName, result, actor, input) =>
					runAfterApplyHooks(channelName, result, actor, input, 0),
				defaultSubscriptions: config.defaultSubscriptions,
				onConnect: config.onConnect,
				onDisconnect: config.onDisconnect,
			})
		: undefined;

	function requireProtocol(): TransportProtocol<TActor> {
		if (!protocol) {
			throw new Error(
				"addTransportSubscriber/removeTransportSubscriber require a transport to be configured",
			);
		}
		return protocol;
	}

	// ── Consumer API ────────────────────────────────────────────────

	return {
		submit(channelName, operationName, input) {
			return internalSubmit(
				channelName as string,
				operationName as string,
				input,
				serverActor,
				`server:${String(serverOpCounter++)}`,
				0,
			);
		},

		broadcastDirtyShards(channelName, shardIds) {
			const ch = getChannelOrThrow(channelName);
			ch.broadcastDirtyShards(shardIds);
		},

		addSubscriber(channelName, subscriber, shardIds) {
			const ch = getChannelOrThrow(channelName);
			ch.addSubscriber(subscriber, shardIds);
		},

		removeSubscriber(channelName, subscriberId) {
			const ch = getChannelOrThrow(channelName);
			ch.removeSubscriber(subscriberId);
		},

		addTransportSubscriber(channelName, connectionId, shardIds) {
			requireProtocol().addTransportSubscriber(
				channelName as string,
				connectionId,
				shardIds,
			);
		},

		removeTransportSubscriber(channelName, connectionId) {
			requireProtocol().removeTransportSubscriber(
				channelName as string,
				connectionId,
			);
		},

		getChannel(channelName) {
			return channels.get(channelName);
		},

		afterApply(channelName, operationName, handler) {
			registerAfterApply(
				channelName as string,
				operationName as string,
				handler as AfterApplyHandler<unknown, TChannels>,
			);
		},
	} as Server<TChannels>;
}
