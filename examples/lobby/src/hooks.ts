import { createKioHooks } from "@kiojs/react";
import { appEngine } from "./schema";

export const { useShardState, useSubmit } = createKioHooks(appEngine);
