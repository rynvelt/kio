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

	function createTransportSubscriber(connectionId: string): Subscriber {
		return {
			id: connectionId,
			send(message) {
				transport?.send(connectionId, {
					type: "broadcast",
					channelId: message.channelId,
					kind: message.kind,
					shards: message.shards,
				});
			},
		};
	}

	// ── Protocol handlers ─────────────────────────────────────────

	/** Pending state between handshake step 1 and step 2 */
	const pendingHandshakes = new Map<
		string,
		{
			actor: TActor;
			channelStates: Array<{
				channelId: string;
				kind: "durable" | "ephemeral";
				shardStates: Map<string, { state: unknown; version: number }>;
			}>;
		}
	>();

	/**
	 * Handshake step 1: validate actor, subscribe to channels,
	 * load shard states, send welcome.
	 */
	async function handleConnection(
		connectionId: string,
		rawActor: unknown,
	): Promise<void> {
		const actor = await actorRegistry.validateAndStore(connectionId, rawActor);
		if (!actor) {
			transport?.send(connectionId, {
				type: "error",
				code: "INVALID_ACTOR",
				message: "Actor validation failed",
			});
			transport?.close(connectionId);
			return;
		}

		const subscriptions = config.defaultSubscriptions?.(actor) ?? [];

		const channelStates: Array<{
			channelId: string;
			kind: "durable" | "ephemeral";
			shardStates: Map<string, { state: unknown; version: number }>;
		}> = [];
		const serverVersions: Record<string, number> = {};

		for (const sub of subscriptions) {
			const ch = channels.get(sub.channelId);
			if (!ch) continue;

			ch.addSubscriber(createTransportSubscriber(connectionId), sub.shardIds);

			const shardStates = await ch.loadShardStates(sub.shardIds);
			channelStates.push({
				channelId: sub.channelId,
				kind: ch.kind,
				shardStates,
			});

			for (const [shardId, { version }] of shardStates) {
				serverVersions[shardId] = version;
			}
		}

		pendingHandshakes.set(connectionId, { actor, channelStates });

		transport?.send(connectionId, {
			type: "welcome",
			actor,
			shards: serverVersions,
		});
	}

	/**
	 * Handshake step 2: diff versions, send state for stale shards, send ready.
	 */
	function handleClientVersions(
		connectionId: string,
		clientVersions: Record<string, number>,
	): void {
		const pending = pendingHandshakes.get(connectionId);
		if (!pending) return;
		pendingHandshakes.delete(connectionId);

		for (const { channelId, kind, shardStates } of pending.channelStates) {
			const entries: Array<{
				shardId: string;
				version: number;
				state: unknown;
			}> = [];

			for (const [shardId, { state, version }] of shardStates) {
				const clientVersion = clientVersions[shardId] ?? 0;
				if (version > clientVersion) {
					entries.push({ shardId, version, state });
				}
			}

			if (entries.length > 0) {
				transport?.send(connectionId, {
					type: "state",
					channelId,
					kind,
					shards: entries,
				});
			}
		}

		transport?.send(connectionId, { type: "ready" });
		config.onConnect?.(pending.actor);
	}

	/** Route a client submit to the right channel, respond with ack/reject. */
	async function handleSubmit(
		connectionId: string,
		message: {
			channelId: string;
			operationName: string;
			input: unknown;
			opId: string;
		},
	): Promise<void> {
		const ch = channels.get(message.channelId);
		if (!ch) {
			transport?.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: "INVALID_CHANNEL",
				message: `Channel "${message.channelId}" is not registered`,
			});
			return;
		}

		const actor = actorRegistry.getActor(connectionId);
		if (!actor) {
			transport?.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: "INTERNAL_ERROR",
				message: "Connection has no associated actor",
			});
			return;
		}

		const result = await ch.submit({
			operationName: message.operationName,
			input: message.input,
			actor,
			opId: message.opId,
		});

		if (result.status === "acknowledged") {
			transport?.send(connectionId, {
				type: "acknowledge",
				opId: message.opId,
			});
			await runAfterApplyHooks(
				message.channelId,
				result,
				actor,
				message.input,
				0,
			);
		} else {
			transport?.send(connectionId, {
				type: "reject",
				opId: message.opId,
				code: result.code,
				message: result.message,
				shards: result.shards,
			});
		}
	}

	/** Clean up actor, unsubscribe from channels, notify consumer. */
	function handleDisconnection(connectionId: string, reason: string): void {
		const actor = actorRegistry.removeActor(connectionId);
		pendingHandshakes.delete(connectionId);

		for (const ch of channels.values()) {
			ch.removeSubscriber(connectionId);
		}

		if (actor) {
			config.onDisconnect?.(actor, reason);
		}
	}

	// ── Wire transport to handlers ──────────────────────────────────

	if (transport) {
		transport.onConnection(async (connectionId, rawActor) => {
			await handleConnection(connectionId, rawActor);
		});

		transport.onMessage(async (connectionId, message) => {
			switch (message.type) {
				case "versions":
					handleClientVersions(connectionId, message.shards);
					break;
				case "submit":
					await handleSubmit(connectionId, message);
					break;
			}
		});

		transport.onDisconnection((connectionId, reason) => {
			handleDisconnection(connectionId, reason);
		});
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
			internalSubmit(ch as string, op as string, submitInput, depth + 1);

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

	// ── Internal submit (shared by consumer API and transport handler) ──

	let serverOpCounter = 0;

	async function internalSubmit(
		channelName: string,
		operationName: string,
		input: unknown,
		depth: number,
	): Promise<PipelineResult> {
		const ch = getChannelOrThrow(channelName);
		const opId = `server:${String(serverOpCounter++)}`;
		const result = await ch.submit({
			operationName,
			input,
			actor: serverActor,
			opId,
		});
		if (result.status === "acknowledged") {
			await runAfterApplyHooks(channelName, result, serverActor, input, depth);
		}
		return result;
	}

	// ── Consumer API ────────────────────────────────────────────────

	return {
		submit(channelName, operationName, input) {
			return internalSubmit(
				channelName as string,
				operationName as string,
				input,
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
			const ch = getChannelOrThrow(channelName);
			ch.addSubscriber(createTransportSubscriber(connectionId), shardIds);
		},

		removeTransportSubscriber(channelName, connectionId) {
			const ch = getChannelOrThrow(channelName);
			ch.removeSubscriber(connectionId);
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
