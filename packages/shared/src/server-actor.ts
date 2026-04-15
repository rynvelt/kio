/**
 * Default `actorId` used for server-as-actor submissions.
 *
 * When the server submits operations (via timers, hooks, or built-in
 * channels like `subscriptions`), it does so as a synthetic system actor
 * with this ID. The pipeline skips `authorize` and `validate` for
 * submissions where `actor.actorId === serverActorId` (configured on the
 * engine), so the constant is also the default value of that config.
 *
 * Consumers using `defineApp` with a custom actor shape should use this
 * constant when constructing their own `serverActor`:
 *
 * ```ts
 * defineApp({
 *   actor: v.object({ actorId: v.string(), name: v.string() }),
 *   serverActor: { actorId: KIO_SERVER_ACTOR_ID, name: "System" },
 * })
 * ```
 */
export const KIO_SERVER_ACTOR_ID = "__kio:server__" as const;

/**
 * Default server-as-actor object — the minimal actor the engine uses when
 * no custom `serverActor` is configured via `defineApp`.
 */
export const KIO_SERVER_ACTOR = { actorId: KIO_SERVER_ACTOR_ID } as const;
