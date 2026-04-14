import { describe, expect, test } from "bun:test";
import { createDirectTransport } from "./direct-transport";
import { expectToBeDefined } from "./test-helpers";

describe("DirectTransport", () => {
	test("client send reaches server handler as raw bytes", () => {
		const { client, server } = createDirectTransport();
		const received: { connectionId: string; data: string | Uint8Array }[] = [];

		server.onMessage((connectionId, data) => {
			received.push({ connectionId, data });
		});

		client.send("hello-server");

		expect(received).toHaveLength(1);
		const first = received[0];
		expectToBeDefined(first);
		expect(first.connectionId).toBe("direct");
		expect(first.data).toBe("hello-server");
	});

	test("server send reaches client handler as raw bytes", () => {
		const { client, server, connectionId } = createDirectTransport();
		const received: (string | Uint8Array)[] = [];

		client.onMessage((data) => {
			received.push(data);
		});

		server.send(connectionId, "hello-client");

		expect(received).toHaveLength(1);
		expect(received[0]).toBe("hello-client");
	});

	test("bidirectional raw-bytes communication", () => {
		const { client, server, connectionId } = createDirectTransport();
		const serverReceived: (string | Uint8Array)[] = [];
		const clientReceived: (string | Uint8Array)[] = [];

		server.onMessage((_connId, data) => {
			serverReceived.push(data);
		});
		client.onMessage((data) => {
			clientReceived.push(data);
		});

		client.send("from-client");
		server.send(connectionId, "from-server");

		expect(serverReceived).toEqual(["from-client"]);
		expect(clientReceived).toEqual(["from-server"]);
	});

	test("transports pass Uint8Array through unchanged", () => {
		const { client, server } = createDirectTransport();
		const received: (string | Uint8Array)[] = [];

		server.onMessage((_id, data) => {
			received.push(data);
		});

		const bytes = new Uint8Array([1, 2, 3, 4]);
		client.send(bytes);

		expect(received).toHaveLength(1);
		expect(received[0]).toBe(bytes);
	});

	test("throws if server handler not registered", () => {
		const { client } = createDirectTransport();

		expect(() => {
			client.send("payload");
		}).toThrow("server message handler not registered");
	});

	test("throws if client handler not registered", () => {
		const { server, connectionId } = createDirectTransport();

		expect(() => {
			server.send(connectionId, "payload");
		}).toThrow("client message handler not registered");
	});
});
