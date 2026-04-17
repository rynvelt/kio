import {
	ActionIcon,
	Anchor,
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
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	addMySession,
	generateSessionCode,
	getMySessions,
	getName,
	type MySessionEntry,
	removeMySession,
	setName,
} from "../../identity";

export const Route = createFileRoute("/present/")({
	component: PresenterDashboard,
});

function PresenterDashboard() {
	const navigate = useNavigate();
	const [name, setLocalName] = useState(getName());
	const [title, setTitle] = useState("");
	const [sessions, setSessions] = useState<MySessionEntry[]>(() =>
		getMySessions(),
	);

	const canCreate = name.trim().length > 0 && title.trim().length > 0;

	function create() {
		if (!canCreate) return;
		const trimmedName = name.trim();
		const trimmedTitle = title.trim();
		setName(trimmedName);
		const code = generateSessionCode();
		addMySession({ code, title: trimmedTitle, createdAt: Date.now() });
		navigate({ to: "/present/$code", params: { code } });
	}

	function remove(code: string) {
		removeMySession(code);
		setSessions(getMySessions());
	}

	return (
		<Container size="sm" mt="xl">
			<Stack gap="lg">
				<Group justify="space-between" align="center">
					<Title order={2}>Present</Title>
					<Anchor component={Link} to="/" size="sm" c="dimmed">
						Home
					</Anchor>
				</Group>

				<Card shadow="sm" padding="lg" radius="md" withBorder>
					<Stack>
						<Title order={4}>New session</Title>
						<TextInput
							label="Your name"
							placeholder="Displayed to the audience"
							value={name}
							onChange={(e) => setLocalName(e.currentTarget.value)}
						/>
						<TextInput
							label="Session title"
							placeholder="e.g. Q4 all-hands poll"
							value={title}
							onChange={(e) => setTitle(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") create();
							}}
						/>
						<Button disabled={!canCreate} onClick={create}>
							Create session
						</Button>
					</Stack>
				</Card>

				<Stack gap="xs">
					<Title order={4}>My sessions</Title>
					{sessions.length === 0 ? (
						<Text c="dimmed" size="sm">
							Sessions you create on this device will appear here.
						</Text>
					) : (
						sessions.map((s) => (
							<Card
								key={s.code}
								shadow="xs"
								padding="sm"
								radius="md"
								withBorder
							>
								<Group justify="space-between">
									<Stack gap={2}>
										<Group gap="xs">
											<Text fw={500}>{s.title}</Text>
											<Badge variant="light">{s.code}</Badge>
										</Group>
										<Text c="dimmed" size="xs">
											{new Date(s.createdAt).toLocaleString()}
										</Text>
									</Stack>
									<Group gap="xs">
										<Button
											size="xs"
											component={Link}
											to="/present/$code"
											params={{ code: s.code }}
										>
											Resume
										</Button>
										<ActionIcon
											variant="subtle"
											color="red"
											onClick={() => remove(s.code)}
											aria-label="Remove from list"
										>
											×
										</ActionIcon>
									</Group>
								</Group>
							</Card>
						))
					)}
				</Stack>
			</Stack>
		</Container>
	);
}
