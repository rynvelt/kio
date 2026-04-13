import type { BaseActor } from "@kio/shared";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Validates and stores actor identities per connection.
 * Pure data ownership — no protocol or subscription logic.
 */
export class ActorRegistry<TActor extends BaseActor> {
	private readonly actors = new Map<string, TActor>();

	constructor(private readonly actorSchema: StandardSchemaV1 | undefined) {}

	/** Validate raw actor against schema, store if valid. Returns null on validation failure. */
	async validateAndStore(
		connectionId: string,
		rawActor: unknown,
	): Promise<TActor | null> {
		if (!this.actorSchema) {
			const actor = rawActor as TActor;
			this.actors.set(connectionId, actor);
			return actor;
		}

		const result = await this.actorSchema["~standard"].validate(rawActor);
		if ("issues" in result && result.issues) {
			return null;
		}

		const actor = ("value" in result ? result.value : rawActor) as TActor;
		this.actors.set(connectionId, actor);
		return actor;
	}

	/** Look up the validated actor for a connection */
	getActor(connectionId: string): TActor | undefined {
		return this.actors.get(connectionId);
	}

	/** Remove and return the actor for a connection */
	removeActor(connectionId: string): TActor | undefined {
		const actor = this.actors.get(connectionId);
		this.actors.delete(connectionId);
		return actor;
	}
}
