import { createKioHooks } from "@kio/react";
import type { appEngine } from "./schema";

export const { useShardState, useSubmit } = createKioHooks<typeof appEngine>();
