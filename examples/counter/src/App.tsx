import { useState } from "react";
import { useShardState, useSubmit } from "./hooks";

export function App() {
	const counter = useShardState("counter", "count", {
		fallback: { value: 0 },
	});
	const presence = useShardState("presence", "users", {
		fallback: { connected: [] },
	});
	const submit = useSubmit("counter");
	const [error, setError] = useState<string | null>(null);
	const ready =
		counter.syncStatus === "latest" || counter.syncStatus === "stale";

	async function handleSubmit(op: "increment" | "decrement" | "reset") {
		setError(null);
		const result = await submit(op, {});
		if (!result.ok) setError(`Submit failed: ${result.status}`);
	}

	const disabled = !ready || counter.pending !== null;

	return (
		<div style={{ fontFamily: "system-ui", padding: "2rem" }}>
			<h1>Kio Counter</h1>
			<p style={{ fontSize: "3rem", margin: "1rem 0" }}>
				{counter.state.value}
			</p>
			<div style={{ display: "flex", gap: "0.5rem" }}>
				<button
					type="button"
					disabled={disabled}
					onClick={() => handleSubmit("decrement")}
				>
					-
				</button>
				<button
					type="button"
					disabled={disabled}
					onClick={() => handleSubmit("increment")}
				>
					+
				</button>
				<button
					type="button"
					disabled={disabled}
					onClick={() => handleSubmit("reset")}
				>
					Reset
				</button>
			</div>
			{counter.pending && (
				<p style={{ color: "#888", fontSize: "0.875rem" }}>
					Pending: {counter.pending.operationName}
				</p>
			)}
			{!ready && (
				<p style={{ color: "#888", fontSize: "0.875rem" }}>Connecting...</p>
			)}
			{error && <p style={{ color: "#c00", fontSize: "0.875rem" }}>{error}</p>}
			<div style={{ marginTop: "2rem", color: "#666" }}>
				<h3>Connected ({presence.state.connected.length})</h3>
				{presence.state.connected.map((u) => (
					<div key={u.id}>{u.id}</div>
				))}
			</div>
		</div>
	);
}
