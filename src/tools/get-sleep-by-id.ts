/**
 * Tool: get_sleep_by_id
 *
 * Fetches a single sleep record by its ID.
 */

import type { WhoopClient } from "../api/client.js";
import type { Sleep } from "../api/types.js";
import { ENDPOINT_SLEEP } from "../api/endpoints.js";

/**
 * Get a single sleep record by ID.
 *
 * @param client - Authenticated WHOOP API client
 * @param id - Sleep record ID
 * @returns Sleep record
 */
export async function getSleepById(client: WhoopClient, id: string): Promise<Sleep> {
  return client.get<Sleep>(`${ENDPOINT_SLEEP}/${encodeURIComponent(id)}`);
}
