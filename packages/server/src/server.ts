import type {
	BaseActor,
	ChannelBuilder,
	Codec,
	EngineBuilder,
	ServerTransport,
	Subscriber,
	SubscriptionsConfig,
	TypedSubscriptionRef,
} from "@kio/shared";
import {
	createSubscriptionsChannel,
	jsonCodec,
	KIO_SERVER_ACTOR,
	SUBSCRIPTIONS_CHANNEL_NAME,
} from "@kio/shared";
import { ActorRegistry } from "./actor-registry";
import { AfterCommitHooks } from "./after-commit-hooks";
import { ChannelRuntime } from "./channel-runtime";
import { type EventEmitter, safeEmit } from "./events";
import type { StateAdapter } from "./persistence";
import type { AuthorizeFn, PipelineResult } from "./pipeline";
import { SubscriptionResolver } from "./subscription-resolver";
import { SubscriptionSyncer } from "./subscription-syncer";
import { TransportProtocol } from "./transport-protocol";

// ── Types & interfaces ──────────────────────────────────────────────

/** Base server config — present regardless of engine subscriptions config. */
interface BaseServerConfig<TActor extends BaseActor> {
	readonly persistence: StateAdapter;
	readonly transport?: ServerTransport;
	/** Serialization codec used at the transport boundary. Defaults to `jsonCodec` (JSON + Set/Map support). */
	readonly codec?: Codec;
	readonly authorize?: AuthorizeFn;
	readonly onConnect?: (actor: TActor) => void;
	readonly onDisconnect?: (actor: TActor, reason: string) => void;
	/**
	 * Structured observability events (op lifecycle, CAS conflicts, broadcast
	 * fanout, hook failures, connection lifecycle). Pipe into your logger /
	 * metrics / tracing backend of choice. See {@link KioEvent} for the
	 * discriminated union. Listener errors are swallowed.
	 */
	readonly onEvent?: EventEmitter;
}

/** Config fields only valid when the engine has subscriptions enabled. */
interface SubscriptionsServerConfig<
	TChannels extends object,
	TActor extends BaseActor,
> {
	/**
	 * Seed refs for a brand-new actor's subscription shard. Called once per
	 * actor, on their first-ever connect (when `subscription:{actorId}` has
	 * version 0). Subsequent connects read the shard directly; revokes
	 * persist. Only valid when the engine has `subscriptions: { kind }` set.
	 */
	readonly defaultSubscriptions?: (
		actor: TActor,
	) => readonly TypedSubscriptionRef<TChannels>[];
}

// biome-ignore lint/complexity/noBannedTypes: empty intersection neutral element
type EmptyConfig = {};

/**
 * Configuration for createServer. `TChannels` is inferred from the engine
 * builder and drives the shape of typed subscription refs; `TActor` feeds
 * hooks that see the actor; `TSubs` gates subscription-specific fields
 * like `defaultSubscriptions` — they only exist on the config type when
 * the engine opted into subscriptions.
 */
export type ServerConfig<
	TChannels extends object = object,
	TActor extends BaseActor = BaseActor,
	TSubs extends SubscriptionsConfig | undefined = undefined,
> = BaseServerConfig<TActor> &
	(TSubs extends SubscriptionsConfig
		? SubscriptionsServerConfig<TChannels, TActor>
		: EmptyConfig);

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

/**
 * Methods available on the Server only when the engine has opted in to
 * the subscriptions feature via `engine({ subscriptions: { kind } })`.
 * Thin wrappers over `server.submit("subscriptions", ...)` so consumers
 * never see the channel name, operation name, or shard wire format.
 */
export interface SubscriptionMethods<TChannels extends object = object> {
	/**
	 * Grant an actor permission to subscribe to a shard. Idempotent —
	 * granting the same ref twice is a no-op (doesn't rev the shard's
	 * version). Submitted as server-as-actor; the pipeline's
	 * `SERVER_ONLY_OPERATION` gate prevents clients from calling the
	 * underlying `grant` operation directly.
	 */
	grantSubscription(
		actorId: string,
		ref: TypedSubscriptionRef<TChannels>,
	): Promise<PipelineResult>;

	/**
	 * Revoke an actor's permission to subscribe to a shard. No-op if the
	 * ref isn't present. Submitted as server-as-actor.
	 */
	revokeSubscription(
		actorId: string,
		ref: TypedSubscriptionRef<TChannels>,
	): Promise<PipelineResult>;
}

// biome-ignore lint/complexity/noBannedTypes: empty object for conditional intersection
type EmptyMethods = {};

/**
 * Conditional addendum to {@link Server}: includes {@link SubscriptionMethods}
 * only when the engine's `TSubs` is a concrete config, otherwise nothing.
 * Calling `grantSubscription` on a server whose engine didn't opt in is a
 * compile-time error.
 */
export type ConditionalSubscriptionMethods<
	TChannels extends object,
	TSubs,
> = TSubs extends SubscriptionsConfig
	? SubscriptionMethods<TChannels>
	: EmptyMethods;

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

	/**
	 * Register a hook that runs after an operation has been applied and persisted
	 * (i.e., after commit). Runs fire-and-forget — hook success/failure does not
	 * affect the op's acknowledge or broadcast. Errors are emitted as
	 * `hook.failed` events to `ServerConfig.onEvent`.
	 */
	afterCommit<
		CName extends string & keyof TChannels,
		OpName extends OperationNames<TChannels[CName]>,
	>(
		channelName: CName,
		operationName: OpName,
		handler: AfterCommitHandler<
			OperationInput<TChannels[CName], OpName>,
			TChannels
		>,
	): void;
}

/** Submit function available inside afterCommit — same signature as Server.submit */
export type AfterCommitSubmitFn<TChannels extends object> = <
	CName extends string & keyof TChannels,
	OpName extends OperationNames<TChannels[CName]>,
>(
	channelName: CName,
	operationName: OpName,
	input: OperationInput<TChannels[CName], OpName>,
) => Promise<PipelineResult>;

/** Context passed to afterCommit handlers */
export interface AfterCommitContext<
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
	readonly submit: AfterCommitSubmitFn<TChannels>;
}

/** Handler function for afterCommit hooks */
export type AfterCommitHandler<
	TInput = unknown,
	TChannels extends object = object,
> = (ctx: AfterCommitContext<TInput, TChannels>) => void | Promise<void>;

// ── createServer ────────────────────────────────────────────────────

export function createServer<
	TChannels extends object,
	TActor extends BaseActor = BaseActor,
	TSubs extends SubscriptionsConfig | undefined = undefined,
>(
	engineBuilder: EngineBuilder<TChannels, TActor, TSubs>,
	config: ServerConfig<TChannels, TActor, TSubs>,
): Server<TChannels> & ConditionalSubscriptionMethods<TChannels, TSubs> {
	const channels = new Map<string, ChannelRuntime>();
	const { transport, onEvent } = config;
	const serverActor: BaseActor =
		engineBuilder["~serverActor"] ?? KIO_SERVER_ACTOR;

	// Setup: create channel runtimes
	for (const [name, channelData] of engineBuilder["~channels"]) {
		channels.set(
			name,
			new ChannelRuntime(channelData, config.persistence, {
				authorize: config.authorize,
				serverActorId: serverActor.actorId,
				onEvent,
			}),
		);
	}

	// Internally register the subscriptions channel if the engine opted in.
	// The consumer never sees "subscriptions" in TChannels — it's engine
	// machinery, exposed through dedicated helpers (Phase 3c).
	const subsConfig = engineBuilder["~subscriptions"];
	if (subsConfig) {
		const subsChannel = createSubscriptionsChannel({ kind: subsConfig.kind });
		channels.set(
			subsChannel["~data"].name,
			new ChannelRuntime(subsChannel["~data"], config.persistence, {
				authorize: config.authorize,
				serverActorId: serverActor.actorId,
				onEvent,
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

	// ── afterCommit hooks ───────────────────────────────────────────

	const afterCommitHooks = new AfterCommitHooks<TChannels>();

	/** Fire-and-forget hook execution. Hooks never block commit, ack, or broadcast. */
	function fireAfterCommit(
		channelName: string,
		result: PipelineResult & { status: "acknowledged" },
		actor: BaseActor,
		input: unknown,
		depth: number,
	): void {
		const boundSubmit: AfterCommitSubmitFn<TChannels> = (ch, op, submitInput) =>
			internalSubmit(
				ch as string,
				op as string,
				submitInput,
				serverActor,
				`server:${String(serverOpCounter++)}`,
				depth + 1,
			);

		afterCommitHooks
			.run(channelName, result, actor, input, depth, boundSubmit)
			.catch((err) => {
				// Safety net only when the consumer hasn't wired onEvent — hooks
				// are fire-and-forget, so a silently-broken hook would otherwise be
				// invisible. Consumers who provide onEvent own their observability.
				if (!onEvent) {
					console.error(
						`[kio] afterCommit error in ${channelName}.${result.operationName}:`,
						err,
					);
				}
				safeEmit(onEvent, {
					type: "hook.failed",
					timestamp: Date.now(),
					channelId: channelName,
					opId: result.opId,
					operationName: result.operationName,
					actor,
					error: err,
				});
			});
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
			fireAfterCommit(channelName, result, actor, input, depth);
		}
		return result;
	}

	// ── Subscription resolver ───────────────────────────────────────
	//
	// Owns all "what shards does this actor see at connect time" logic:
	// reads the subscription shard (if enabled), bootstraps on first
	// connect via defaultSubscriptions, auto-appends own shard ref.
	// TransportProtocol uses this via a neutral `resolveInitialShards`
	// callback and has no knowledge of subscriptions.
	const subsConfigForResolver = engineBuilder["~subscriptions"];
	const configWithSubs = config as BaseServerConfig<TActor> &
		Partial<SubscriptionsServerConfig<TChannels, TActor>>;
	const subscriptionResolver = new SubscriptionResolver<TActor>({
		subsChannel: subsConfigForResolver
			? channels.get(SUBSCRIPTIONS_CHANNEL_NAME)
			: undefined,
		serverActor,
		submit: (channelName, submission) =>
			getChannelOrThrow(channelName).submit(submission),
		defaultSubscriptions: configWithSubs.defaultSubscriptions,
	});

	// ── Transport protocol (only when transport is configured) ──────

	const protocol = transport
		? new TransportProtocol<TActor>({
				transport,
				codec: config.codec ?? jsonCodec,
				actorRegistry,
				channels,
				submit: (channelName, submission) =>
					getChannelOrThrow(channelName).submit(submission),
				runAfterCommit: (channelName, result, actor, input) => {
					fireAfterCommit(channelName, result, actor, input, 0);
				},
				resolveInitialShards: (actor) =>
					subscriptionResolver.resolveForActor(actor),
				onConnect: (actor) => {
					safeEmit(onEvent, {
						type: "connection.opened",
						timestamp: Date.now(),
						actor,
					});
					config.onConnect?.(actor);
				},
				onDisconnect: (actor, reason) => {
					safeEmit(onEvent, {
						type: "connection.closed",
						timestamp: Date.now(),
						actor,
						reason,
					});
					config.onDisconnect?.(actor, reason);
				},
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

	// ── Subscription syncer (runtime subscriber-map sync) ───────────
	//
	// When a grant/revoke commits while the target actor is connected,
	// the syncer updates their subscriber map and delivers current shard
	// state. Registered as an internal afterCommit handler on the
	// subscriptions channel — invisible to consumers.
	if (subsConfigForResolver) {
		const syncer = new SubscriptionSyncer<TActor>({
			actorRegistry,
			addConnectionToShard(connectionId, channelId, shardId) {
				protocol?.ensureTransportSubscription(channelId, connectionId, [
					shardId,
				]);
			},
			removeConnectionFromShard(connectionId, channelId, shardId) {
				const ch = channels.get(channelId);
				ch?.removeShards(connectionId, [shardId]);
			},
			async sendShardState(connectionId, channelId, shardIds) {
				const ch = channels.get(channelId);
				if (!ch || !protocol) return;
				const shardStates = await ch.loadShardStates(shardIds);
				const entries: Array<{
					shardId: string;
					version: number;
					state: unknown;
				}> = [];
				for (const [shardId, { state, version }] of shardStates) {
					entries.push({ shardId, version, state });
				}
				if (entries.length > 0) {
					protocol.sendToConnection(connectionId, {
						type: "state",
						channelId,
						kind: ch.kind,
						shards: entries,
					});
				}
			},
		});

		afterCommitHooks.register(
			SUBSCRIPTIONS_CHANNEL_NAME,
			"grant",
			async ({ input }) => {
				const typed = input as {
					actorId: string;
					ref: { channelId: string; shardId: string };
				};
				await syncer.onGrant(typed);
			},
		);

		afterCommitHooks.register(
			SUBSCRIPTIONS_CHANNEL_NAME,
			"revoke",
			({ input }) => {
				const typed = input as {
					actorId: string;
					ref: { channelId: string; shardId: string };
				};
				syncer.onRevoke(typed);
			},
		);
	}

	// ── Consumer API ────────────────────────────────────────────────

	const base: Server<TChannels> = {
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

		afterCommit(channelName, operationName, handler) {
			afterCommitHooks.register(
				channelName as string,
				operationName as string,
				handler as AfterCommitHandler<unknown, TChannels>,
			);
		},
	};

	// Conditionally attach the subscription helpers at runtime. The declared
	// return type hides them when subscriptions aren't enabled; this check
	// ensures the runtime surface matches — JS consumers with no types can't
	// call them by accident, and devtools show only the keys that actually work.
	const subsEnabled = engineBuilder["~subscriptions"];
	if (subsEnabled) {
		const methods: SubscriptionMethods<TChannels> = {
			grantSubscription(actorId, ref) {
				return internalSubmit(
					SUBSCRIPTIONS_CHANNEL_NAME,
					"grant",
					{ actorId, ref },
					serverActor,
					`server:${String(serverOpCounter++)}`,
					0,
				);
			},
			revokeSubscription(actorId, ref) {
				return internalSubmit(
					SUBSCRIPTIONS_CHANNEL_NAME,
					"revoke",
					{ actorId, ref },
					serverActor,
					`server:${String(serverOpCounter++)}`,
					0,
				);
			},
		};
		Object.assign(base, methods);
	}

	return base as Server<TChannels> &
		ConditionalSubscriptionMethods<TChannels, TSubs>;
}
