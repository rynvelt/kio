import type { Client } from "@kiojs/client";
import { KioProvider } from "@kiojs/react";
import {
	Button,
	Card,
	Container,
	Stack,
	TextInput,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { connectToLobby } from "./connection";
import { Lobby } from "./Lobby";

export function App() {
	const [connection, setConnection] = useState<{
		client: Client;
		actorId: string;
		name: string;
	} | null>(null);

	if (!connection) {
		return (
			<JoinForm
				onJoin={(name) => {
					const { client, actorId } = connectToLobby(name);
					setConnection({ client, actorId, name });
				}}
			/>
		);
	}

	return (
		<KioProvider client={connection.client}>
			<Lobby actorId={connection.actorId} name={connection.name} />
		</KioProvider>
	);
}

function JoinForm({ onJoin }: { onJoin: (name: string) => void }) {
	const [name, setName] = useState("");

	return (
		<Container size="xs" mt="xl">
			<Card shadow="sm" padding="lg" radius="md" withBorder>
				<Stack>
					<Title order={2}>Join Lobby</Title>
					<TextInput
						label="Your name"
						placeholder="Enter your name"
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && name.trim()) onJoin(name.trim());
						}}
					/>
					<Button disabled={!name.trim()} onClick={() => onJoin(name.trim())}>
						Join
					</Button>
				</Stack>
			</Card>
		</Container>
	);
}
