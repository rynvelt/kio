const ACTOR_ID_KEY = "kio-poll:actorId";
const NAME_KEY = "kio-poll:name";
const MY_SESSIONS_KEY = "kio-poll:mySessions";

export function getActorId(): string {
	let id = localStorage.getItem(ACTOR_ID_KEY);
	if (!id) {
		id = crypto.randomUUID();
		localStorage.setItem(ACTOR_ID_KEY, id);
	}
	return id;
}

export function getName(): string {
	return localStorage.getItem(NAME_KEY) ?? "";
}

export function setName(name: string): void {
	localStorage.setItem(NAME_KEY, name);
}

export type MySessionEntry = { code: string; title: string; createdAt: number };

export function getMySessions(): MySessionEntry[] {
	const raw = localStorage.getItem(MY_SESSIONS_KEY);
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isSessionEntry);
	} catch {
		return [];
	}
}

function isSessionEntry(value: unknown): value is MySessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.code === "string" &&
		typeof v.title === "string" &&
		typeof v.createdAt === "number"
	);
}

export function addMySession(entry: MySessionEntry): void {
	const current = getMySessions().filter((s) => s.code !== entry.code);
	current.unshift(entry);
	localStorage.setItem(MY_SESSIONS_KEY, JSON.stringify(current));
}

export function removeMySession(code: string): void {
	const current = getMySessions().filter((s) => s.code !== code);
	localStorage.setItem(MY_SESSIONS_KEY, JSON.stringify(current));
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateSessionCode(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	let code = "";
	for (const b of bytes) {
		const alphaChar = CODE_ALPHABET[b % CODE_ALPHABET.length];
		if (alphaChar === undefined) continue;
		code += alphaChar;
	}
	return code;
}
