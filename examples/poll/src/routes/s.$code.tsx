import type { Client } from "@kiojs/client";
import { KioProvider } from "@kiojs/react";
import {
	Alert,
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
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ResultsChart } from "../components/ResultsChart";
import { connect } from "../connection";
import { useShardState, useSubmit } from "../hooks";
import { getActorId, getName, setName } from "../identity";
import type { SessionState, Slide } from "../schema";

export const Route = createFileRoute("/s/$code")({
	component: AudiencePage,
});

function AudiencePage() {
	const { code } = Route.useParams();
	const [name, setLocalName] = useState(getName());
	const [submittedName, setSubmittedName] = useState(name.trim().length > 0);

	if (!submittedName) {
		return (
			<Container size="xs" mt="xl">
				<Card shadow="sm" padding="lg" radius="md" withBorder>
					<Stack>
						<Title order={3}>Join {code}</Title>
						<TextInput
							label="Your name"
							placeholder="Enter your name"
							value={name}
							onChange={(e) => setLocalName(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && name.trim()) {
									setName(name.trim());
									setSubmittedName(true);
								}
							}}
						/>
						<Button
							disabled={name.trim().length === 0}
							onClick={() => {
								setName(name.trim());
								setSubmittedName(true);
							}}
						>
							Continue
						</Button>
					</Stack>
				</Card>
			</Container>
		);
	}

	return <ConnectedAudience code={code} name={name.trim()} />;
}

function ConnectedAudience({ code, name }: { code: string; name: string }) {
	const [connection, setConnection] = useState<{
		client: Client;
		actorId: string;
	} | null>(null);

	useEffect(() => {
		const c = connect({ name, sessionCode: code });
		setConnection(c);
	}, [code, name]);

	if (!connection) {
		return (
			<Container size="sm" mt="xl">
				<Text>Connecting…</Text>
			</Container>
		);
	}

	return (
		<KioProvider client={connection.client}>
			<AudienceView code={code} />
		</KioProvider>
	);
}

function AudienceView({ code }: { code: string }) {
	const session = useShardState("poll", "session", code);

	if (session.syncStatus !== "latest" && session.syncStatus !== "stale") {
		return (
			<Container size="md" mt="xl">
				<Text>Loading session…</Text>
			</Container>
		);
	}

	const state = session.state;

	if (state.presenterActorId === null) {
		return (
			<Container size="sm" mt="xl">
				<Alert color="yellow" title="Session not found">
					<Stack gap="xs">
						<Text>No session with code {code} exists.</Text>
						<Button component={Link} to="/join" size="xs" w="fit-content">
							Try another code
						</Button>
					</Stack>
				</Alert>
			</Container>
		);
	}

	if (state.deletedAt !== null) {
		return (
			<Container size="sm" mt="xl">
				<Alert color="gray" title="Session ended">
					<Text>This session has been deleted by the presenter.</Text>
				</Alert>
			</Container>
		);
	}

	return <AudienceSession state={state} />;
}

function AudienceSession({ state }: { state: SessionState }) {
	const activeSlide = state.slides.find((s) => s.id === state.activeSlideId);
	const lastClosed = [...state.slides]
		.reverse()
		.find((s) => s.phase === "closed");
	const displaySlide = activeSlide ?? lastClosed ?? null;

	return (
		<Container size="md" mt="md">
			<Stack gap="lg">
				<Stack gap={2}>
					<Title order={2}>{state.title}</Title>
					<Group gap="xs">
						<Text c="dimmed" size="sm">
							Presented by {state.presenterName}
						</Text>
						<Badge variant="light">{state.code}</Badge>
					</Group>
				</Stack>

				{displaySlide ? (
					<SlideView slide={displaySlide} sessionCode={state.code} />
				) : (
					<Card shadow="sm" padding="xl" radius="md" withBorder>
						<Stack align="center" gap="xs">
							<Title order={3}>Waiting for the presenter</Title>
							<Text c="dimmed">The first slide hasn't started yet.</Text>
						</Stack>
					</Card>
				)}
			</Stack>
		</Container>
	);
}

function SlideView({
	slide,
	sessionCode,
}: {
	slide: Slide;
	sessionCode: string;
}) {
	const submit = useSubmit("poll");
	const myActorId = getActorId();
	const myVote = slide.votes[myActorId];

	return (
		<Card shadow="sm" padding="lg" radius="md" withBorder>
			<Stack>
				<Group justify="space-between">
					<Title order={3}>{slide.question}</Title>
					<Badge color={slide.phase === "live" ? "red" : "gray"}>
						{slide.phase === "live" ? "LIVE" : "closed"}
					</Badge>
				</Group>

				{slide.phase === "live" ? (
					<Stack gap="xs">
						{slide.options.map((opt) => (
							<Button
								key={opt.id}
								variant={myVote === opt.id ? "filled" : "default"}
								color={myVote === opt.id ? "blue" : "gray"}
								size="md"
								onClick={() =>
									submit("submitVote", {
										code: sessionCode,
										slideId: slide.id,
										optionId: opt.id,
									})
								}
							>
								{opt.label}
							</Button>
						))}
					</Stack>
				) : (
					<Text c="dimmed" size="sm">
						Voting closed.
					</Text>
				)}

				<ResultsChart slide={slide} />
			</Stack>
		</Card>
	);
}
