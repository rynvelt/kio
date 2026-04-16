import { createKioHooks } from "@kio/react";
import { appEngine } from "./schema";

export const { useShardState, useSubmit, useMySubscriptions } =
	createKioHooks(appEngine);
