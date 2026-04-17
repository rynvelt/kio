import { engine, KIO_SERVER_ACTOR_ID } from "@kio/shared";
import * as v from "valibot";

// ── Actor ──────────────────────────────────────────────────────────────
// sessionCode piggybacks on the actor so the server can route default
// subscriptions at connect time without an extra handshake op.

const actorSchema = v.object({
	actorId: v.string(),
	name: v.string(),
	sessionCode: v.nullable(v.string()),
});

export type Actor = v.InferOutput<typeof actorSchema>;

// ── Engine ─────────────────────────────────────────────────────────────

const app = engine({
	actor: actorSchema,
	serverActor: {
		actorId: KIO_SERVER_ACTOR_ID,
		name: "Server",
		sessionCode: null,
	},
	subscriptions: { kind: "ephemeral" },
});

// ── Shard shapes ───────────────────────────────────────────────────────

const optionSchema = v.object({
	id: v.string(),
	label: v.string(),
});

export type PollOption = v.InferOutput<typeof optionSchema>;

const slideSchema = v.object({
	id: v.string(),
	type: v.literal("multipleChoice"),
	question: v.string(),
	options: v.array(optionSchema),
	/** optionId → vote count */
	results: v.record(v.string(), v.number()),
	/** actorId → optionId (enables change-vote while slide is live) */
	votes: v.record(v.string(), v.string()),
	phase: v.picklist(["draft", "live", "closed"]),
});

export type Slide = v.InferOutput<typeof slideSchema>;

const sessionSchema = v.object({
	code: v.string(),
	title: v.string(),
	/** null = not yet created (default-materialised shard) */
	presenterActorId: v.nullable(v.string()),
	presenterName: v.string(),
	createdAt: v.number(),
	deletedAt: v.nullable(v.number()),
	slides: v.array(slideSchema),
	activeSlideId: v.nullable(v.string()),
});

export type SessionState = v.InferOutput<typeof sessionSchema>;

const defaultSession: SessionState = {
	code: "",
	title: "",
	presenterActorId: null,
	presenterName: "",
	createdAt: 0,
	deletedAt: null,
	slides: [],
	activeSlideId: null,
};

// ── Poll channel ───────────────────────────────────────────────────────

export const pollChannel = app.channel
	.durable("poll")
	.shardPerResource("session", sessionSchema, { defaultState: defaultSession })
	// Presenter creates a new session. CAS on version 0 ensures two clients
	// racing on the same code can't both succeed.
	.operation("createSession", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ code: v.string(), title: v.string() }),
		errors: v.picklist(["CODE_IN_USE"]),
		scope: (input) => [app.shard.ref("session", input.code)],
	})
	.serverImpl("createSession", {
		validate(shards, input, _ctx, { reject }) {
			if (shards.session(input.code).presenterActorId !== null) {
				reject("CODE_IN_USE", "Session code already taken");
			}
		},
		apply(shards, input, _sr, ctx) {
			const s = shards.session(input.code);
			s.code = input.code;
			s.title = input.title;
			s.presenterActorId = ctx.actor.actorId;
			s.presenterName = ctx.actor.name;
			s.createdAt = Date.now();
			s.deletedAt = null;
			s.slides = [];
			s.activeSlideId = null;
		},
	})
	.operation("deleteSession", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ code: v.string() }),
		errors: v.picklist(["UNAUTHORIZED", "NOT_FOUND"]),
		scope: (input) => [app.shard.ref("session", input.code)],
	})
	.serverImpl("deleteSession", {
		validate(shards, input, ctx, { reject }) {
			const s = shards.session(input.code);
			if (s.presenterActorId === null) reject("NOT_FOUND", "Session not found");
			if (s.presenterActorId !== ctx.actor.actorId) {
				reject("UNAUTHORIZED", "Only the presenter can delete this session");
			}
		},
		apply(shards, input) {
			const s = shards.session(input.code);
			s.deletedAt = Date.now();
			s.activeSlideId = null;
		},
	})
	.operation("addSlide", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({
			code: v.string(),
			slide: v.object({
				id: v.string(),
				question: v.string(),
				options: v.array(v.object({ id: v.string(), label: v.string() })),
			}),
		}),
		errors: v.picklist(["UNAUTHORIZED", "NOT_FOUND"]),
		scope: (input) => [app.shard.ref("session", input.code)],
	})
	.serverImpl("addSlide", {
		validate(shards, input, ctx, { reject }) {
			const s = shards.session(input.code);
			if (s.presenterActorId === null) reject("NOT_FOUND", "Session not found");
			if (s.presenterActorId !== ctx.actor.actorId) {
				reject("UNAUTHORIZED", "Only the presenter can edit this session");
			}
		},
		apply(shards, input) {
			const s = shards.session(input.code);
			const results: Record<string, number> = {};
			for (const opt of input.slide.options) results[opt.id] = 0;
			s.slides.push({
				id: input.slide.id,
				type: "multipleChoice",
				question: input.slide.question,
				options: input.slide.options,
				results,
				votes: {},
				phase: "draft",
			});
		},
	})
	.operation("removeSlide", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ code: v.string(), slideId: v.string() }),
		errors: v.picklist(["UNAUTHORIZED", "NOT_FOUND"]),
		scope: (input) => [app.shard.ref("session", input.code)],
	})
	.serverImpl("removeSlide", {
		validate(shards, input, ctx, { reject }) {
			const s = shards.session(input.code);
			if (s.presenterActorId === null) reject("NOT_FOUND", "Session not found");
			if (s.presenterActorId !== ctx.actor.actorId) {
				reject("UNAUTHORIZED", "Only the presenter can edit this session");
			}
		},
		apply(shards, input) {
			const s = shards.session(input.code);
			s.slides = s.slides.filter((sl) => sl.id !== input.slideId);
			if (s.activeSlideId === input.slideId) s.activeSlideId = null;
		},
	})
	// Transition slide phases. slideId === null closes any currently-live
	// slide. Otherwise: close any previously-live slide and mark the new
	// slide live. Previously-closed slides stay closed when re-activated
	// would reset their results, so we only allow draft → live here.
	.operation("setActiveSlide", {
		execution: "confirmed",
		versionChecked: true,
		deduplicate: false,
		input: v.object({ code: v.string(), slideId: v.nullable(v.string()) }),
		errors: v.picklist(["UNAUTHORIZED", "NOT_FOUND", "INVALID_SLIDE"]),
		scope: (input) => [app.shard.ref("session", input.code)],
	})
	.serverImpl("setActiveSlide", {
		validate(shards, input, ctx, { reject }) {
			const s = shards.session(input.code);
			if (s.presenterActorId === null) reject("NOT_FOUND", "Session not found");
			if (s.presenterActorId !== ctx.actor.actorId) {
				reject("UNAUTHORIZED", "Only the presenter can control this session");
			}
			if (input.slideId !== null) {
				const slide = s.slides.find((sl) => sl.id === input.slideId);
				if (!slide) reject("INVALID_SLIDE", "Slide not found");
				if (slide && slide.phase === "closed") {
					reject("INVALID_SLIDE", "Cannot re-open a closed slide");
				}
			}
		},
		apply(shards, input) {
			const s = shards.session(input.code);
			if (s.activeSlideId) {
				const prev = s.slides.find((sl) => sl.id === s.activeSlideId);
				if (prev && prev.phase === "live") prev.phase = "closed";
			}
			if (input.slideId) {
				const next = s.slides.find((sl) => sl.id === input.slideId);
				if (next) next.phase = "live";
			}
			s.activeSlideId = input.slideId;
		},
	})
	// Audience votes. Optimistic so the voter sees their bar grow instantly.
	// CAS contention is the demo: many voters hitting the same shard.
	.operation("submitVote", {
		execution: "optimistic",
		versionChecked: true,
		deduplicate: false,
		input: v.object({
			code: v.string(),
			slideId: v.string(),
			optionId: v.string(),
		}),
		errors: v.picklist(["SLIDE_NOT_LIVE"]),
		scope: (input) => [app.shard.ref("session", input.code)],
		apply(shards, input, _sr, ctx) {
			const s = shards.session(input.code);
			const slide = s.slides.find((sl) => sl.id === input.slideId);
			if (!slide || slide.phase !== "live") return;
			if (!slide.options.some((o) => o.id === input.optionId)) return;
			const prev = slide.votes[ctx.actor.actorId];
			if (prev === input.optionId) return;
			if (prev !== undefined) {
				slide.results[prev] = (slide.results[prev] ?? 0) - 1;
			}
			slide.results[input.optionId] = (slide.results[input.optionId] ?? 0) + 1;
			slide.votes[ctx.actor.actorId] = input.optionId;
		},
	})
	.serverImpl("submitVote", {
		validate(shards, input, _ctx, { reject }) {
			const s = shards.session(input.code);
			const slide = s.slides.find((sl) => sl.id === input.slideId);
			if (!slide || slide.phase !== "live") {
				reject("SLIDE_NOT_LIVE", "Slide is not accepting votes");
			}
		},
	});

// ── App engine ─────────────────────────────────────────────────────────

export const appEngine = app.register(pollChannel);

export { app };
