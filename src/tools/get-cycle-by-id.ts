/**
 * Tool: get_cycle_by_id
 *
 * Fetches a single physiological cycle record by its ID.
 */

import type { WhoopClient } from "../api/client.js";
import type { Cycle } from "../api/types.js";
import { ENDPOINT_CYCLE } from "../api/endpoints.js";

/**
 * Get a single cycle record by ID.
 *
 * @param client - Authenticated WHOOP API client
 * @param id - Cycle record ID (numeric)
 * @returns Cycle record
 */
export async function getCycleById(client: WhoopClient, id: number): Promise<Cycle> {
  return client.get<Cycle>(`${ENDPOINT_CYCLE}/${id}`);
}
