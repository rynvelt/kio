import type { Client } from "@kio/client";
import { createContext, type ReactNode, useContext } from "react";

// Store the client as unknown — typed access comes from createKioHooks
const KioContext = createContext<Client<Record<string, never>> | null>(null);

export function KioProvider<TChannels extends object>({
	client,
	children,
}: {
	client: Client<TChannels>;
	children: ReactNode;
}) {
	return (
		<KioContext value={client as Client<Record<string, never>>}>
			{children}
		</KioContext>
	);
}

export function useKioClientInternal(): Client<Record<string, never>> {
	const client = useContext(KioContext);
	if (!client) {
		throw new Error("Kio hooks must be used within a KioProvider");
	}
	return client;
}
