import {
	Badge,
	Button,
	Card,
	Container,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useShardState, useSubmit } from "./hooks";
import type { RoomState } from "./schema";

export function Lobby({ actorId, name }: { actorId: string; name: string }) {
	const room = useShardState("lobby", "room");
	const submit = useSubmit("lobby");

	// Join the lobby on mount
	useEffect(() => {
		submit("join", { actorId, name });
	}, [submit, actorId, name]);

	if (room.syncStatus === "loading" || room.syncStatus === "unavailable") {
		return (
			<Container size="sm" mt="xl">
				<Text>Connecting...</Text>
			</Container>
		);
	}

	const state = room.state as RoomState;

	if (state.phase === "started") {
		return <GameStarted />;
	}

	return (
		<Container size="sm" mt="xl">
			<Stack>
				<Group justify="space-between">
					<Title order={2}>Lobby</Title>
					<PhaseBadge
						phase={state.phase}
						countdownEndsAt={state.countdownEndsAt}
					/>
				</Group>

				<Stack gap="xs">
					{state.players.map((player) => (
						<PlayerCard
							key={player.actorId}
							name={player.name}
							ready={player.ready}
							isMe={player.actorId === actorId}
							onToggleReady={() => {
								submit("setReady", {
									actorId,
									ready: !player.ready,
								});
							}}
						/>
					))}
					{state.players.length === 0 && (
						<Text c="dimmed">No players yet...</Text>
					)}
				</Stack>

				{state.players.length < 2 && (
					<Text c="dimmed" size="sm">
						Need at least 2 players to start
					</Text>
				)}
			</Stack>
		</Container>
	);
}

function PlayerCard({
	name,
	ready,
	isMe,
	onToggleReady,
}: {
	name: string;
	ready: boolean;
	isMe: boolean;
	onToggleReady: () => void;
}) {
	return (
		<Card shadow="xs" padding="sm" radius="md" withBorder>
			<Group justify="space-between">
				<Group>
					<Text fw={isMe ? 700 : 400}>
						{name}
						{isMe && " (you)"}
					</Text>
				</Group>
				{isMe ? (
					<Button
						size="xs"
						variant={ready ? "filled" : "outline"}
						color={ready ? "green" : "gray"}
						onClick={onToggleReady}
					>
						{ready ? "Ready" : "Not ready"}
					</Button>
				) : (
					<Badge color={ready ? "green" : "gray"} variant="light">
						{ready ? "Ready" : "Not ready"}
					</Badge>
				)}
			</Group>
		</Card>
	);
}

function PhaseBadge({
	phase,
	countdownEndsAt,
}: {
	phase: RoomState["phase"];
	countdownEndsAt: number | null;
}) {
	const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

	useEffect(() => {
		if (phase !== "countdown" || !countdownEndsAt) {
			setSecondsLeft(null);
			return;
		}

		function tick() {
			const remaining = Math.max(
				0,
				Math.ceil(((countdownEndsAt as number) - Date.now()) / 1000),
			);
			setSecondsLeft(remaining);
		}

		tick();
		const interval = setInterval(tick, 100);
		return () => clearInterval(interval);
	}, [phase, countdownEndsAt]);

	if (phase === "countdown" && secondsLeft !== null) {
		return (
			<Badge size="lg" color="yellow" variant="filled">
				Starting in {secondsLeft}...
			</Badge>
		);
	}

	return (
		<Badge size="lg" color="blue" variant="light">
			Waiting for players
		</Badge>
	);
}

function GameStarted() {
	return (
		<Container size="sm" mt="xl">
			<Card shadow="sm" padding="xl" radius="md" withBorder>
				<Stack align="center">
					<Title order={1}>Game Started!</Title>
					<Text c="dimmed">This is where the game would begin.</Text>
				</Stack>
			</Card>
		</Container>
	);
}
