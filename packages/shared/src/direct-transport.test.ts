import { describe, expect, test } from "bun:test";
import { createDirectTransport } from "./direct-transport";
import { expectToBeDefined } from "./test-helpers";
import type { ClientMessage, ServerMessage } from "./transport";

describe("DirectTransport", () => {
	test("client send reaches server handler", () => {
		const { client, server } = createDirectTransport();
		const received: { connectionId: string; message: ClientMessage }[] = [];

		server.onMessage((connectionId, message) => {
			received.push({ connectionId, message });
		});

		client.send({
			type: "submit",
			channelId: "game",
			operationName: "advanceTurn",
			input: {},
			opId: "op-1",
		});

		expect(received).toHaveLength(1);
		const first = received[0];
		expectToBeDefined(first);
		expect(first.connectionId).toBe("direct");
		expect(first.message.type).toBe("submit");
		if (first.message.type === "submit") {
			expect(first.message.operationName).toBe("advanceTurn");
		}
	});

	test("server send reaches client handler", () => {
		const { client, server, connectionId } = createDirectTransport();
		const received: ServerMessage[] = [];

		client.onMessage((message) => {
			received.push(message);
		});

		server.send(connectionId, {
			type: "acknowledge",
			opId: "op-1",
		});

		expect(received).toHaveLength(1);
		expectToBeDefined(received[0]);
		expect(received[0].type).toBe("acknowledge");
	});

	test("bidirectional communication", () => {
		const { client, server, connectionId } = createDirectTransport();
		const serverReceived: ClientMessage[] = [];
		const clientReceived: ServerMessage[] = [];

		server.onMessage((_connId, message) => {
			serverReceived.push(message);
		});
		client.onMessage((message) => {
			clientReceived.push(message);
		});

		client.send({
			type: "submit",
			channelId: "game",
			operationName: "op",
			input: {},
			opId: "op-1",
		});

		server.send(connectionId, {
			type: "acknowledge",
			opId: "op-1",
		});

		expect(serverReceived).toHaveLength(1);
		expect(clientReceived).toHaveLength(1);
	});

	test("throws if server handler not registered", () => {
		const { client } = createDirectTransport();

		expect(() => {
			client.send({
				type: "submit",
				channelId: "game",
				operationName: "op",
				input: {},
				opId: "op-1",
			});
		}).toThrow("server message handler not registered");
	});

	test("throws if client handler not registered", () => {
		const { server, connectionId } = createDirectTransport();

		expect(() => {
			server.send(connectionId, {
				type: "acknowledge",
				opId: "op-1",
			});
		}).toThrow("client message handler not registered");
	});
});
