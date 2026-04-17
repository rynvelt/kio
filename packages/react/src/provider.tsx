import type { Client, UntypedClient } from "@kiojs/client";
import { createContext, type ReactNode, useContext } from "react";

// Store the client as untyped — typed access comes from createKioHooks.
const KioContext = createContext<UntypedClient | null>(null);

export function KioProvider<TChannels extends object>({
	client,
	children,
}: {
	client: Client<TChannels>;
	children: ReactNode;
}) {
	return <KioContext value={client as UntypedClient}>{children}</KioContext>;
}

export function useKioClientInternal(): UntypedClient {
	const client = useContext(KioContext);
	if (!client) {
		throw new Error("Kio hooks must be used within a KioProvider");
	}
	return client;
}
