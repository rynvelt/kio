import {
	Button,
	Card,
	Container,
	Stack,
	TextInput,
	Title,
} from "@mantine/core";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getName, setName } from "../identity";

export const Route = createFileRoute("/join")({
	component: Join,
});

function Join() {
	const navigate = useNavigate();
	const [name, setLocalName] = useState(getName());
	const [code, setCode] = useState("");

	const canSubmit = name.trim().length > 0 && code.trim().length > 0;

	function submit() {
		if (!canSubmit) return;
		setName(name.trim());
		navigate({ to: "/s/$code", params: { code: code.trim().toUpperCase() } });
	}

	return (
		<Container size="xs" mt="xl">
			<Card shadow="sm" padding="lg" radius="md" withBorder>
				<Stack>
					<Title order={2}>Join session</Title>
					<TextInput
						label="Your name"
						placeholder="Enter your name"
						value={name}
						onChange={(e) => setLocalName(e.currentTarget.value)}
					/>
					<TextInput
						label="Session code"
						placeholder="e.g. ABC123"
						value={code}
						onChange={(e) =>
							setCode(e.currentTarget.value.toUpperCase().replace(/\s/g, ""))
						}
						onKeyDown={(e) => {
							if (e.key === "Enter") submit();
						}}
					/>
					<Button disabled={!canSubmit} onClick={submit}>
						Join
					</Button>
				</Stack>
			</Card>
		</Container>
	);
}
