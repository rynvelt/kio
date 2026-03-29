import type { ChannelData } from "./channel";
import { ShardStore } from "./shard-store";
import type { ShardState } from "./state";
import type {
	AcknowledgeMessage,
	BroadcastServerMessage,
	ClientTransport,
	RejectMessage,
	StateMessage,
} from "./transport";

type PendingSubmit = {
	resolve: (result: AcknowledgeMessage | RejectMessage) => void;
};

/**
 * Client-side engine for one channel.
 * Owns ShardStores. Created by createClient, not by consumer code.
 *
 * ShardStores are created when the server sends initial state during
 * the connection handshake — the server decides which shards the
 * client receives, not the client.
 */
export class ClientChannelEngine {
	private readonly stores = new Map<
		string,
		ShardStore<Record<string, unknown>>
	>();
	private readonly pendingSubmits = new Map<string, PendingSubmit>();
	private opCounter = 0;

	constructor(
		private readonly channelData: ChannelData,
		private readonly transport: ClientTransport,
	) {}

	/**
	 * Handle a state message from the server (initial sync during handshake).
	 * Creates ShardStores for shards we haven't seen, grants access, applies state.
	 */
	handleStateMessage(message: StateMessage): void {
		for (const entry of message.shards) {
			let store = this.stores.get(entry.shardId);
			if (!store) {
				store = new ShardStore<Record<string, unknown>>(this.channelData.kind);
				this.stores.set(entry.shardId, store);
			}
			store.grantAccess();
			store.applyBroadcastEntry(entry);
		}
	}

	/** Handle a broadcast message from the server (ongoing state updates) */
	handleBroadcastMessage(message: BroadcastServerMessage): void {
		for (const entry of message.shards) {
			const store = this.stores.get(entry.shardId);
			if (store) {
				store.applyBroadcastEntry(entry);
			}
		}
	}

	/** Handle acknowledge or reject for a pending submit */
	handleSubmitResponse(message: AcknowledgeMessage | RejectMessage): void {
		const pending = this.pendingSubmits.get(message.opId);
		if (pending) {
			this.pendingSubmits.delete(message.opId);
			pending.resolve(message);
		}
	}

	/** Get the ShardState snapshot for a shard */
	shardState(shardId: string): ShardState<Record<string, unknown>> {
		const store = this.stores.get(shardId);
		if (!store) {
			return { syncStatus: "unavailable", state: null, pending: null };
		}
		return store.snapshot;
	}

	/** Subscribe to changes on a specific shard */
	subscribeToShard(shardId: string, listener: () => void): () => void {
		const store = this.stores.get(shardId);
		if (!store) return () => {};
		return store.subscribe(listener);
	}

	/** Submit an operation via the transport. Returns when server responds. */
	async submit(
		operationName: string,
		input: unknown,
	): Promise<AcknowledgeMessage | RejectMessage> {
		const opId = `${this.channelData.name}:${String(this.opCounter++)}`;

		const promise = new Promise<AcknowledgeMessage | RejectMessage>(
			(resolve) => {
				this.pendingSubmits.set(opId, { resolve });
			},
		);

		this.transport.send({
			type: "submit",
			channelId: this.channelData.name,
			operationName,
			input,
			opId,
		});

		return promise;
	}

	get name(): string {
		return this.channelData.name;
	}
}
