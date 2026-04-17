import type { Client } from "@kio/client";
import { KioProvider } from "@kio/react";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Card,
	Container,
	CopyButton,
	Divider,
	Group,
	Input,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ResultsChart } from "../../components/ResultsChart";
import { connect } from "../../connection";
import { useShardState, useSubmit } from "../../hooks";
import { getMySessions, getName, removeMySession } from "../../identity";
import type { Slide } from "../../schema";

export const Route = createFileRoute("/present/$code")({
	component: RunnerPage,
});

function RunnerPage() {
	const { code } = Route.useParams();
	const name = getName();

	if (!name.trim()) {
		return (
			<Container size="sm" mt="xl">
				<Alert color="yellow" title="Name required">
					<Stack gap="xs">
						<Text>
							Set your name on the dashboard before opening a session.
						</Text>
						<Button component={Link} to="/present" size="xs" w="fit-content">
							Go to dashboard
						</Button>
					</Stack>
				</Alert>
			</Container>
		);
	}

	return <ConnectedRunner code={code} name={name} />;
}

function ConnectedRunner({ code, name }: { code: string; name: string }) {
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
			<Runner code={code} actorId={connection.actorId} />
		</KioProvider>
	);
}

function Runner({ code, actorId }: { code: string; actorId: string }) {
	const navigate = useNavigate();
	const session = useShardState("poll", "session", code);
	const submit = useSubmit("poll");

	const titleFromLocal = useMemo(
		() =>
			getMySessions().find((s) => s.code === code)?.title ?? "Untitled poll",
		[code],
	);

	// If we arrive with a fresh code and the session doesn't exist on the
	// server yet, create it. We only attempt once to avoid thrashing if
	// creation genuinely fails.
	const [createAttempted, setCreateAttempted] = useState(false);
	useEffect(() => {
		if (createAttempted) return;
		if (session.syncStatus !== "latest" && session.syncStatus !== "stale") {
			return;
		}
		if (session.state.presenterActorId === null) {
			setCreateAttempted(true);
			submit("createSession", { code, title: titleFromLocal });
		}
	}, [createAttempted, session, submit, code, titleFromLocal]);

	if (session.syncStatus !== "latest" && session.syncStatus !== "stale") {
		return (
			<Container size="md" mt="xl">
				<Text>Loading session…</Text>
			</Container>
		);
	}

	const state = session.state;

	if (state.deletedAt !== null) {
		return (
			<Container size="sm" mt="xl">
				<Alert color="red" title="Session deleted">
					<Stack gap="xs">
						<Text>This session has been deleted.</Text>
						<Button
							component={Link}
							to="/present"
							size="xs"
							w="fit-content"
							onClick={() => removeMySession(code)}
						>
							Back to dashboard
						</Button>
					</Stack>
				</Alert>
			</Container>
		);
	}

	if (state.presenterActorId === null) {
		return (
			<Container size="sm" mt="xl">
				<Text>Creating session…</Text>
			</Container>
		);
	}

	if (state.presenterActorId !== actorId) {
		return (
			<Container size="sm" mt="xl">
				<Alert color="red" title="Not your session">
					<Text>
						This session belongs to {state.presenterName}. Only they can run it.
					</Text>
				</Alert>
			</Container>
		);
	}

	const activeSlide = state.slides.find((s) => s.id === state.activeSlideId);

	return (
		<Container size="md" mt="md">
			<Stack gap="lg">
				<Group justify="space-between" align="center">
					<Stack gap={2}>
						<Title order={2}>{state.title}</Title>
						<Group gap="xs">
							<Text c="dimmed" size="sm">
								Code
							</Text>
							<Badge size="lg" variant="light">
								{state.code}
							</Badge>
							<CopyButton value={state.code}>
								{({ copied, copy }) => (
									<Button size="compact-xs" variant="subtle" onClick={copy}>
										{copied ? "Copied" : "Copy"}
									</Button>
								)}
							</CopyButton>
						</Group>
					</Stack>
					<Group>
						<Button component={Link} to="/present" variant="subtle" size="xs">
							Dashboard
						</Button>
						<Button
							color="red"
							variant="subtle"
							size="xs"
							onClick={() => {
								submit("deleteSession", { code });
								removeMySession(code);
								navigate({ to: "/present" });
							}}
						>
							Delete
						</Button>
					</Group>
				</Group>

				{activeSlide && (
					<Card shadow="sm" padding="lg" radius="md" withBorder>
						<Stack>
							<Group justify="space-between">
								<Badge color="red">LIVE</Badge>
								<Text c="dimmed" size="sm">
									Everyone subscribed to this session is voting right now
								</Text>
							</Group>
							<Title order={3}>{activeSlide.question}</Title>
							<ResultsChart slide={activeSlide} />
							<Button
								variant="default"
								onClick={() =>
									submit("setActiveSlide", { code, slideId: null })
								}
							>
								Close slide
							</Button>
						</Stack>
					</Card>
				)}

				<Divider label="Slides" labelPosition="left" />

				<Stack gap="sm">
					{state.slides.map((slide) => (
						<SlideRow
							key={slide.id}
							slide={slide}
							onOpen={() =>
								submit("setActiveSlide", { code, slideId: slide.id })
							}
							onRemove={() =>
								submit("removeSlide", { code, slideId: slide.id })
							}
						/>
					))}
					{state.slides.length === 0 && (
						<Text c="dimmed" size="sm">
							No slides yet. Add one below.
						</Text>
					)}
				</Stack>

				<Divider label="Add slide" labelPosition="left" />

				<AddSlideForm onAdd={(slide) => submit("addSlide", { code, slide })} />
			</Stack>
		</Container>
	);
}

function SlideRow({
	slide,
	onOpen,
	onRemove,
}: {
	slide: Slide;
	onOpen: () => void;
	onRemove: () => void;
}) {
	return (
		<Card shadow="xs" padding="sm" radius="md" withBorder>
			<Group justify="space-between" align="flex-start">
				<Stack gap={2} style={{ flex: 1 }}>
					<Group gap="xs">
						<PhaseBadge phase={slide.phase} />
						<Text fw={500}>{slide.question}</Text>
					</Group>
					<Text c="dimmed" size="xs">
						{slide.options.map((o) => o.label).join(" · ")}
					</Text>
				</Stack>
				<Group gap="xs">
					{slide.phase === "draft" && (
						<Button size="xs" onClick={onOpen}>
							Open
						</Button>
					)}
					{slide.phase === "closed" && (
						<Badge variant="light" color="gray">
							{Object.values(slide.results).reduce((a, b) => a + b, 0)} votes
						</Badge>
					)}
					<ActionIcon
						variant="subtle"
						color="red"
						onClick={onRemove}
						aria-label="Remove slide"
					>
						×
					</ActionIcon>
				</Group>
			</Group>
		</Card>
	);
}

function PhaseBadge({ phase }: { phase: Slide["phase"] }) {
	if (phase === "live") return <Badge color="red">LIVE</Badge>;
	if (phase === "closed") return <Badge color="gray">closed</Badge>;
	return <Badge variant="light">draft</Badge>;
}

function AddSlideForm({
	onAdd,
}: {
	onAdd: (slide: {
		id: string;
		question: string;
		options: { id: string; label: string }[];
	}) => void;
}) {
	const [question, setQuestion] = useState("");
	const [options, setOptions] = useState<{ id: string; value: string }[]>(
		() => [
			{ id: crypto.randomUUID(), value: "" },
			{ id: crypto.randomUUID(), value: "" },
		],
	);

	function setOption(id: string, value: string) {
		setOptions((prev) => prev.map((o) => (o.id === id ? { ...o, value } : o)));
	}

	function addOption() {
		setOptions((prev) => [...prev, { id: crypto.randomUUID(), value: "" }]);
	}

	function removeOption(id: string) {
		setOptions((prev) => prev.filter((o) => o.id !== id));
	}

	const validOptions = options
		.map((o) => o.value.trim())
		.filter((v) => v.length > 0);
	const canAdd = question.trim().length > 0 && validOptions.length >= 2;

	function submit() {
		if (!canAdd) return;
		onAdd({
			id: crypto.randomUUID(),
			question: question.trim(),
			options: validOptions.map((label) => ({
				id: crypto.randomUUID(),
				label,
			})),
		});
		setQuestion("");
		setOptions([
			{ id: crypto.randomUUID(), value: "" },
			{ id: crypto.randomUUID(), value: "" },
		]);
	}

	return (
		<Card shadow="xs" padding="sm" radius="md" withBorder>
			<Stack>
				<TextInput
					label="Question"
					placeholder="What would you like to ask?"
					value={question}
					onChange={(e) => setQuestion(e.currentTarget.value)}
				/>
				<Input.Wrapper label="Options">
					<Stack gap="xs">
						{options.map((opt, idx) => (
							<Group key={opt.id} gap="xs">
								<TextInput
									placeholder={`Option ${String(idx + 1)}`}
									value={opt.value}
									onChange={(e) => setOption(opt.id, e.currentTarget.value)}
									style={{ flex: 1 }}
								/>
								<ActionIcon
									variant="subtle"
									color="red"
									disabled={options.length <= 2}
									onClick={() => removeOption(opt.id)}
									aria-label="Remove option"
								>
									×
								</ActionIcon>
							</Group>
						))}
					</Stack>
				</Input.Wrapper>
				<Group justify="space-between">
					<Button variant="subtle" size="xs" onClick={addOption}>
						+ Add option
					</Button>
					<Button disabled={!canAdd} onClick={submit}>
						Add slide
					</Button>
				</Group>
			</Stack>
		</Card>
	);
}
