import { engine } from "@kio/shared";
import { fogChannel, gameChannel, presenceChannel } from "./schema";

export const clientEngine = engine()
	.register(
		gameChannel
			.clientImpl("useItem", {
				canRetry(input, freshShards) {
					return freshShards
						.seat(input.seatId)
						.inventory.some((i) => i.id === input.itemId);
				},
			})
			.clientImpl("visitLocation", {
				canRetry(input, freshShards) {
					return !freshShards
						.seat(input.seatId)
						.visitedLocations.has(input.locationSlug);
				},
			})
			.clientImpl("transferItem", {
				canRetry(input, freshShards) {
					return freshShards
						.seat(input.fromSeatId)
						.inventory.some((i) => i.id === input.itemId);
				},
			}),
	)
	.register(presenceChannel)
	.register(fogChannel);
