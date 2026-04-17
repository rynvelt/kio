import {
	Button,
	Card,
	Container,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
	component: Landing,
});

function Landing() {
	return (
		<Container size="sm" mt="xl">
			<Stack gap="xl">
				<Stack gap="xs" align="center">
					<Title order={1}>Kio Poll</Title>
					<Text c="dimmed">Live, real-time polling</Text>
				</Stack>
				<Group grow>
					<RoleCard
						title="Present"
						description="Create a session and run live polls."
						to="/present"
					/>
					<RoleCard
						title="Join"
						description="Enter a session code to vote."
						to="/join"
					/>
				</Group>
			</Stack>
		</Container>
	);
}

function RoleCard({
	title,
	description,
	to,
}: {
	title: string;
	description: string;
	to: "/present" | "/join";
}) {
	return (
		<Card shadow="sm" padding="lg" radius="md" withBorder>
			<Stack>
				<Title order={3}>{title}</Title>
				<Text c="dimmed" size="sm">
					{description}
				</Text>
				<Button component={Link} to={to} fullWidth>
					Go
				</Button>
			</Stack>
		</Card>
	);
}
