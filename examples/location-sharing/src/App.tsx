import type { Client } from "@kiojs/client";
import { KioProvider } from "@kiojs/react";
import {
	Badge,
	Button,
	Card,
	Container,
	Group,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { useMySubscriptions, useShardState, useSubmit } from "./hooks";
import type { LocationState } from "./schema";
import { setupApp } from "./setup";

const GRID_SIZE = 8;

// ── Join form ──────────────────────────────────────────────────────────

export function App() {
	const [connection, setConnection] = useState<{
		client: Client;
		name: string;
		actorId: string;
	} | null>(null);
	const [nameInput, setNameInput] = useState("");

	if (!connection) {
		return (
			<Container size="xs" mt="xl">
				<Card shadow="sm" padding="lg" radius="md" withBorder>
					<Stack>
						<Title order={2}>Location Sharing</Title>
						<TextInput
							label="Your name"
							placeholder="Enter your name"
							value={nameInput}
							onChange={(e) => setNameInput(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && nameInput.trim()) {
									const name = nameInput.trim();
									const { client } = setupApp(name);
									const actorId = name.toLowerCase().replace(/\s+/g, "-");
									setConnection({ client, name, actorId });
								}
							}}
						/>
						<Button
							disabled={!nameInput.trim()}
							onClick={() => {
								const name = nameInput.trim();
								const { client } = setupApp(name);
								const actorId = name.toLowerCase().replace(/\s+/g, "-");
								setConnection({ client, name, actorId });
							}}
						>
							Connect
						</Button>
					</Stack>
				</Card>
			</Container>
		);
	}

	return (
		<KioProvider client={connection.client}>
			<Dashboard myActorId={connection.actorId} myName={connection.name} />
		</KioProvider>
	);
}

// ── Dashboard ──────────────────────────────────────────────────────────

function Dashboard({
	myActorId,
	myName,
}: {
	myActorId: string;
	myName: string;
}) {
	const room = useShardState("room", "room", {
		fallback: { players: [] },
	});
	// x/y of -1 keeps the pin off the visible 0..GRID_SIZE-1 grid.
	const myPresence = useShardState("presence", "player", myActorId, {
		fallback: { name: "", x: -1, y: -1 },
	});
	const mySharing = useShardState("sharing", "actor", myActorId, {
		fallback: { sharedWith: [] },
	});
	const mySubs = useMySubscriptions();
	const submitPresence = useSubmit("presence");
	const submitSharing = useSubmit("sharing");

	const players = room.state.players;
	const otherPlayers = players.filter((p) => p.actorId !== myActorId);
	const sharingWith = mySharing.state.sharedWith;

	const sharedPresenceShardIds: string[] = [];
	if (mySubs.syncStatus === "latest" || mySubs.syncStatus === "stale") {
		for (const ref of mySubs.state.refs) {
			if (
				ref.channelId === "presence" &&
				ref.shardId !== `player:${myActorId}`
			) {
				sharedPresenceShardIds.push(ref.shardId);
			}
		}
	}

	const myLoc = myPresence.state;

	return (
		<Container size="lg" mt="md">
			<Title order={2} mb="md">
				Location Sharing — {myName}
			</Title>

			<Group align="flex-start" gap="xl">
				<Stack>
					<Text fw={500}>Click to move</Text>
					<LocationGrid
						myLoc={myLoc}
						sharedPresenceShardIds={sharedPresenceShardIds}
						onCellClick={(x, y) => submitPresence("updateLocation", { x, y })}
					/>
				</Stack>

				<Stack style={{ minWidth: 250 }}>
					<Title order={4}>
						Online{" "}
						<Badge size="sm" variant="light">
							{players.length}
						</Badge>
					</Title>

					{otherPlayers.length === 0 && (
						<Text c="dimmed" size="sm">
							Open another tab to add a second player
						</Text>
					)}

					{otherPlayers.map((p) => {
						const isSharing = sharingWith.includes(p.actorId);
						return (
							<Group key={p.actorId} gap="xs">
								<Text size="sm">{p.name}</Text>
								<Button
									size="compact-xs"
									color={isSharing ? "red" : "green"}
									variant="filled"
									onClick={() => {
										if (isSharing) {
											submitSharing("stopShare", {
												targetActorId: p.actorId,
											});
										} else {
											submitSharing("startShare", {
												targetActorId: p.actorId,
											});
										}
									}}
								>
									{isSharing ? "Stop sharing" : "Share my location"}
								</Button>
							</Group>
						);
					})}

					<Title order={4} mt="md">
						Shared with me{" "}
						<Badge size="sm" variant="light">
							{sharedPresenceShardIds.length}
						</Badge>
					</Title>

					{sharedPresenceShardIds.length === 0 && (
						<Text c="dimmed" size="sm">
							Nobody is sharing their location with you yet
						</Text>
					)}

					{sharedPresenceShardIds.map((shardId) => (
						<SharedPlayerInfo key={shardId} shardId={shardId} />
					))}
				</Stack>
			</Group>
		</Container>
	);
}

// ── Grid ───────────────────────────────────────────────────────────────
// Each shared player's presence is read via a dedicated child component
// (SharedPlayerPin) to avoid calling hooks inside loops.

const CELL_SIZE = 50;

function LocationGrid({
	myLoc,
	sharedPresenceShardIds,
	onCellClick,
}: {
	myLoc: LocationState;
	sharedPresenceShardIds: string[];
	onCellClick: (x: number, y: number) => void;
}) {
	return (
		<div style={{ position: "relative" }}>
			{/* CSS grid with fixed cell sizes — no gap drift */}
			<div
				style={{
					display: "grid",
					gridTemplateColumns: `repeat(${String(GRID_SIZE)}, ${String(CELL_SIZE)}px)`,
					gridTemplateRows: `repeat(${String(GRID_SIZE)}, ${String(CELL_SIZE)}px)`,
					gap: 0,
				}}
			>
				{Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => {
					const x = i % GRID_SIZE;
					const y = Math.floor(i / GRID_SIZE);
					const isMe = myLoc.x === x && myLoc.y === y;
					return (
						<Button
							key={`${String(x)}-${String(y)}`}
							variant={isMe ? "filled" : "default"}
							color={isMe ? "blue" : "gray"}
							size="compact-xs"
							radius={0}
							style={{
								width: CELL_SIZE,
								height: CELL_SIZE,
								padding: 0,
							}}
							onClick={() => onCellClick(x, y)}
						>
							{isMe ? "You" : ""}
						</Button>
					);
				})}
			</div>

			{/* Shared player pins rendered as overlay circles */}
			{sharedPresenceShardIds.map((shardId) => (
				<SharedPlayerPin key={shardId} shardId={shardId} />
			))}
		</div>
	);
}

/**
 * Reads a shared player's presence and renders an overlay circle at
 * their grid position. One hook call per component instance.
 */
function SharedPlayerPin({ shardId }: { shardId: string }) {
	const resourceId = shardId.replace("player:", "");
	const shard = useShardState("presence", "player", resourceId);

	if (shard.syncStatus !== "latest" && shard.syncStatus !== "stale") {
		return null;
	}

	const { x, y, name } = shard.state;
	const offset = (CELL_SIZE - 36) / 2;
	return (
		<div
			style={{
				position: "absolute",
				left: x * CELL_SIZE + offset,
				top: y * CELL_SIZE + offset,
				width: 36,
				height: 36,
				borderRadius: "50%",
				background: "#e67e22",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				color: "white",
				fontSize: "0.55rem",
				fontWeight: 600,
				pointerEvents: "none",
			}}
		>
			{name}
		</div>
	);
}

// ── Shared player info (sidebar) ───────────────────────────────────────

function SharedPlayerInfo({ shardId }: { shardId: string }) {
	const resourceId = shardId.replace("player:", "");
	const shard = useShardState("presence", "player", resourceId);

	if (shard.syncStatus === "unavailable") return null;
	if (shard.syncStatus === "loading") {
		return (
			<Text size="sm" c="dimmed">
				Loading {resourceId}...
			</Text>
		);
	}

	return (
		<Text size="sm">
			<Text span fw={600}>
				{shard.state.name}
			</Text>{" "}
			at ({shard.state.x}, {shard.state.y})
		</Text>
	);
}
