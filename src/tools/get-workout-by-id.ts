/**
 * Tool: get_workout_by_id
 *
 * Fetches a single workout record by its ID.
 */

import type { WhoopClient } from "../api/client.js";
import type { Workout } from "../api/types.js";
import { ENDPOINT_WORKOUT } from "../api/endpoints.js";

/**
 * Get a single workout record by ID.
 *
 * @param client - Authenticated WHOOP API client
 * @param id - Workout record ID
 * @returns Workout record
 */
export async function getWorkoutById(client: WhoopClient, id: string): Promise<Workout> {
  return client.get<Workout>(`${ENDPOINT_WORKOUT}/${encodeURIComponent(id)}`);
}
