import { useShardState, useSubmit } from "./hooks";

export function App() {
	const counter = useShardState("counter", "count");
	const presence = useShardState("presence", "users");
	const submit = useSubmit("counter");

	if (
		counter.syncStatus === "loading" ||
		counter.syncStatus === "unavailable"
	) {
		return <p>Connecting...</p>;
	}

	const { state, pending } = counter;
	const users =
		presence.syncStatus === "latest" || presence.syncStatus === "stale"
			? presence.state.connected
			: [];

	return (
		<div style={{ fontFamily: "system-ui", padding: "2rem" }}>
			<h1>Kio Counter</h1>
			<p style={{ fontSize: "3rem", margin: "1rem 0" }}>{state.value}</p>
			<div style={{ display: "flex", gap: "0.5rem" }}>
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit("decrement", {})}
				>
					-
				</button>
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit("increment", {})}
				>
					+
				</button>
				<button
					type="button"
					disabled={pending !== null}
					onClick={() => submit("reset", {})}
				>
					Reset
				</button>
			</div>
			{pending && (
				<p style={{ color: "#888", fontSize: "0.875rem" }}>
					Pending: {pending.operationName}
				</p>
			)}
			<div style={{ marginTop: "2rem", color: "#666" }}>
				<h3>Connected ({users.length})</h3>
				{users.map((u) => (
					<div key={u.id}>{u.id}</div>
				))}
			</div>
		</div>
	);
}
