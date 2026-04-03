import { useShardState, useSubmit } from "./hooks";

export function App() {
	const shard = useShardState("counter", "count");
	const submit = useSubmit("counter");

	if (shard.syncStatus === "loading") {
		return <p>Loading...</p>;
	}

	if (shard.syncStatus === "unavailable") {
		return <p>Unavailable</p>;
	}

	const { state, pending } = shard;

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
		</div>
	);
}
