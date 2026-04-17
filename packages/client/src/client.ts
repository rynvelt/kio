import type {
	BaseActor,
	ChannelBuilder,
	ClientMessage,
	ClientTransport,
	Codec,
	EngineBuilder,
	ServerMessage,
	ShardState,
	SubmitResult,
	SubscriptionShardState,
	SubscriptionsConfig,
} from "@kiojs/shared";
import {
	createSubscriptionsChannel,
	jsonCodec,
	SUBSCRIPTIONS_CHANNEL_NAME,
} from "@kiojs/shared";
import { ClientChannelEngine } from "./client-channel-engine";

/** Configuration for createClient */
export interface ClientConfig {
	readonly transport: ClientTransport;
	/** Serialization codec used at the transport boundary. Defaults to `jsonCodec` (JSON + Set/Map support). */
	readonly codec?: Codec;
	/** Timeout in ms for submit operations. Default: 10000 */
	readonly submitTimeoutMs?: number;
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

/** Typed channel handle — consumer uses this to submit and read state */
export interface ClientChannel<Ch> {
	submit<OpName extends OperationNames<Ch>>(
		operationName: OpName,
		input: OperationInput<Ch, OpName>,
	): Promise<SubmitResult>;

	shardState(shardId: string): ShardState<Record<string, unknown>>;

	subscribeToShard(shardId: string, listener: () => void): () => void;
}

/**
 * Methods available on the Client only when the engine has opted in to
 * the subscriptions feature via `engine({ subscriptions: { kind } })`.
 * Let consumers observe their own subscription shard without knowing
 * the internal channel name, shard ID format, or their actor ID.
 */
export interface ClientSubscriptionMethods {
	/**
	 * Snapshot of the actor's current subscription shard. Returns a
	 * `"loading"` state when the welcome handshake hasn't arrived yet
	 * (actor ID unknown).
	 */
	mySubscriptions(): ShardState<SubscriptionShardState>;

	/**
	 * Subscribe to changes on the actor's subscription shard. Listener
	 * fires when the shard state changes via broadcasts. Returns an
	 * unsubscribe function.
	 */
	subscribeToMySubscriptions(listener: () => void): () => void;
}

// biome-ignore lint/complexity/noBannedTypes: empty object for conditional intersection
type EmptyMethods = {};

/**
 * Conditional addendum to {@link Client}: includes
 * {@link ClientSubscriptionMethods} only when the engine's `TSubs` is a
 * concrete config, otherwise nothing.
 */
export type ConditionalClientSubscriptionMethods<TSubs> =
	TSubs extends SubscriptionsConfig ? ClientSubscriptionMethods : EmptyMethods;

/** Typed client instance */
export interface Client<TChannels extends object = object> {
	channel<CName extends string & keyof TChannels>(
		channelName: CName,
	): ClientChannel<TChannels[CName]>;

	readonly ready: boolean;
}

/** Untyped client — used by framework bindings (React hooks, etc.) */
export type UntypedClient = Client<Record<string, never>>;

/** Create a client from an engine builder and config */
export function createClient<
	TChannels extends object,
	TActor extends BaseActor = BaseActor,
	TSubs extends SubscriptionsConfig | undefined = undefined,
>(
	engineBuilder: EngineBuilder<TChannels, TActor, TSubs>,
	config: ClientConfig,
): Client<TChannels> & ConditionalClientSubscriptionMethods<TSubs> {
	const engines = new Map<string, ClientChannelEngine>();
	let isReady = false;
	const timeoutMs = config.submitTimeoutMs ?? 10_000;
	const codec = config.codec ?? jsonCodec;

	/** Send a typed ClientMessage through the raw transport, encoded via codec. */
	const sendMessage = (message: ClientMessage): void => {
		config.transport.send(codec.encode(message));
	};

	// Create a ClientChannelEngine per channel
	for (const [name, channelData] of engineBuilder["~channels"]) {
		engines.set(
			name,
			new ClientChannelEngine(channelData, sendMessage, timeoutMs),
		);
	}

	// Internally register the subscriptions channel if the engine opted in.
	// Mirrors createServer — both sides agree on kind because they share the
	// same engine config imported from the consumer's schema file.
	const subsConfig = engineBuilder["~subscriptions"];
	if (subsConfig) {
		const subsChannel = createSubscriptionsChannel({ kind: subsConfig.kind });
		engines.set(
			subsChannel["~data"].name,
			new ClientChannelEngine(subsChannel["~data"], sendMessage, timeoutMs),
		);
	}

	// Wire transport messages to the right engine
	config.transport.onMessage((data) => {
		const message = codec.decode(data) as ServerMessage;
		switch (message.type) {
			case "welcome":
				// Server sent welcome with full actor + versions — respond with ours
				for (const eng of engines.values()) {
					eng.setActor(message.actor);
				}
				// Now that actor IDs are known, attach any subscribeToMySubscriptions
				// listeners that were queued before welcome arrived.
				for (const thunk of pendingMySubs) thunk();
				pendingMySubs.length = 0;
				// Detects ref removals on the subscription shard and transitions
				// the matching ShardStores to unavailable. Grants are handled by
				// the server's point-to-point state push after a runtime grant.
				installSubscriptionWatcher();
				sendMessage({
					type: "versions",
					shards: collectLocalVersions(engines),
				});
				break;

			case "state": {
				const eng = engines.get(message.channelId);
				eng?.handleStateMessage(message);
				break;
			}

			case "broadcast": {
				const eng = engines.get(message.channelId);
				eng?.handleBroadcastMessage(message);
				break;
			}

			case "ready":
				isReady = true;
				break;

			case "acknowledge":
			case "reject":
				// Route to the engine that owns the opId
				for (const eng of engines.values()) {
					eng.handleSubmitResponse(message);
				}
				break;
		}
	});

	// When transport connects, the server initiates the handshake
	config.transport.onConnected(() => {
		// Nothing to do — server sends welcome first, we respond in onMessage
	});

	// On disconnect, resolve all pending submits with disconnected
	config.transport.onDisconnected(() => {
		isReady = false;
		for (const eng of engines.values()) {
			eng.handleDisconnect();
		}
	});

	const channelHandles = new Map<string, ClientChannel<never>>();

	// Shard state returned by mySubscriptions() before the welcome handshake
	// arrives — actor ID is unknown, so we can't construct the shard ID.
	const MY_SUBS_LOADING: ShardState<SubscriptionShardState> = {
		syncStatus: "loading",
		state: null,
		pending: null,
	};

	// Subscribe thunks queued by subscribeToMySubscriptions when the actor ID
	// isn't known yet. Flushed in the welcome handler once setActor has run.
	const pendingMySubs: Array<() => void> = [];

	function mySubscriptions(): ShardState<SubscriptionShardState> {
		const subsEng = engines.get(SUBSCRIPTIONS_CHANNEL_NAME);
		if (!subsEng) return MY_SUBS_LOADING;
		const actorId = subsEng.getActorId();
		if (!actorId) return MY_SUBS_LOADING;
		return subsEng.shardState(
			`subscription:${actorId}`,
		) as ShardState<SubscriptionShardState>;
	}

	function subscribeToMySubscriptions(listener: () => void): () => void {
		const subsEng = engines.get(SUBSCRIPTIONS_CHANNEL_NAME);
		if (!subsEng) return () => {};
		const actorId = subsEng.getActorId();
		if (actorId) {
			return subsEng.subscribeToShard(`subscription:${actorId}`, listener);
		}
		// Pre-welcome: queue a thunk that subscribes once the actor is known.
		// The returned unsubscribe works in either state.
		let realUnsubscribe: (() => void) | null = null;
		let cancelled = false;
		pendingMySubs.push(() => {
			if (cancelled) return;
			const id = subsEng.getActorId();
			if (!id) return;
			realUnsubscribe = subsEng.subscribeToShard(
				`subscription:${id}`,
				listener,
			);
		});
		return () => {
			cancelled = true;
			realUnsubscribe?.();
		};
	}

	// Tracks refs from the last observed subscription-shard state, so
	// the watcher can diff and detect removals.
	let watcherPreviousRefs: ReadonlyArray<{
		channelId: string;
		shardId: string;
	}> = [];
	let watcherInstalled = false;

	/**
	 * Install a listener on the actor's own subscription shard. On each
	 * update, diff the refs against the previous set. For refs that
	 * disappeared, revoke access on the matching ShardStore so the
	 * client transitions it to unavailable.
	 */
	function installSubscriptionWatcher(): void {
		const subsEng = engines.get(SUBSCRIPTIONS_CHANNEL_NAME);
		if (!subsEng || watcherInstalled) return;
		const actorId = subsEng.getActorId();
		if (!actorId) return;
		watcherInstalled = true;

		subsEng.subscribeToShard(`subscription:${actorId}`, () => {
			const snapshot = subsEng.shardState(`subscription:${actorId}`);
			if (snapshot.syncStatus !== "latest" && snapshot.syncStatus !== "stale") {
				return;
			}
			const currentRefs = (snapshot.state as unknown as SubscriptionShardState)
				.refs;

			for (const prev of watcherPreviousRefs) {
				const stillPresent = currentRefs.some(
					(r) => r.channelId === prev.channelId && r.shardId === prev.shardId,
				);
				if (!stillPresent) {
					engines.get(prev.channelId)?.revokeShardAccess(prev.shardId);
				}
			}

			watcherPreviousRefs = currentRefs;
		});
	}

	const base = {
		channel(channelName: string & keyof TChannels) {
			let handle = channelHandles.get(channelName);
			if (!handle) {
				const eng = engines.get(channelName);
				if (!eng) {
					throw new Error(`Channel "${channelName}" is not registered`);
				}
				handle = {
					submit(operationName: string, input: unknown) {
						return eng.submit(operationName, input);
					},
					shardState(shardId: string) {
						return eng.shardState(shardId);
					},
					subscribeToShard(shardId: string, listener: () => void) {
						return eng.subscribeToShard(shardId, listener);
					},
				} as ClientChannel<never>;
				channelHandles.set(channelName, handle);
			}
			return handle as ClientChannel<TChannels[typeof channelName]>;
		},
		get ready() {
			return isReady;
		},
	};

	// Conditionally attach the subscription helpers at runtime. The declared
	// return type hides them when subscriptions aren't enabled; this check
	// ensures the runtime surface matches — JS consumers with no types can't
	// call them by accident, and devtools show only the keys that actually work.
	if (subsConfig) {
		const methods: ClientSubscriptionMethods = {
			mySubscriptions,
			subscribeToMySubscriptions,
		};
		Object.assign(base, methods);
	}

	return base as Client<TChannels> &
		ConditionalClientSubscriptionMethods<TSubs>;
}

/** Collect local shard versions from all engines for reconnect handshake */
function collectLocalVersions(
	engines: Map<string, ClientChannelEngine>,
): Record<string, number> {
	const versions: Record<string, number> = {};
	for (const eng of engines.values()) {
		Object.assign(versions, eng.getShardVersions());
	}
	return versions;
}
