import type { BaseActor } from "@kiojs/shared";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Validates and stores actor identities per connection.
 * Pure data ownership — no protocol or subscription logic.
 */
export class ActorRegistry<TActor extends BaseActor> {
	private readonly actors = new Map<string, TActor>();
	/** Reverse map: actorId → connectionIds (supports multi-tab). */
	private readonly connections = new Map<string, Set<string>>();

	constructor(private readonly actorSchema: StandardSchemaV1 | undefined) {}

	/** Validate raw actor against schema, store if valid. Returns null on validation failure. */
	async validateAndStore(
		connectionId: string,
		rawActor: unknown,
	): Promise<TActor | null> {
		if (!this.actorSchema) {
			const actor = rawActor as TActor;
			this.storeActor(connectionId, actor);
			return actor;
		}

		const result = await this.actorSchema["~standard"].validate(rawActor);
		if ("issues" in result && result.issues) {
			return null;
		}

		const actor = ("value" in result ? result.value : rawActor) as TActor;
		this.storeActor(connectionId, actor);
		return actor;
	}

	/** Look up the validated actor for a connection */
	getActor(connectionId: string): TActor | undefined {
		return this.actors.get(connectionId);
	}

	/** Get all live connectionIds for a given actorId. Empty set if none. */
	getConnections(actorId: string): ReadonlySet<string> {
		return this.connections.get(actorId) ?? emptySet;
	}

	/** Remove and return the actor for a connection */
	removeActor(connectionId: string): TActor | undefined {
		const actor = this.actors.get(connectionId);
		this.actors.delete(connectionId);
		if (actor) {
			const conns = this.connections.get(actor.actorId);
			if (conns) {
				conns.delete(connectionId);
				if (conns.size === 0) this.connections.delete(actor.actorId);
			}
		}
		return actor;
	}

	private storeActor(connectionId: string, actor: TActor): void {
		this.actors.set(connectionId, actor);
		let conns = this.connections.get(actor.actorId);
		if (!conns) {
			conns = new Set();
			this.connections.set(actor.actorId, conns);
		}
		conns.add(connectionId);
	}
}

const emptySet: ReadonlySet<string> = new Set();
