/** Whether a workflow can run on this computer right now, in the three states the library shows. Client-safe. */
export type Availability = "ready" | "setup" | "definition";

export interface AvailabilityInfo {
  state: Availability;
  /** Plain-language reason when it isn't ready. Never contains a key or other secret. */
  reason: string | null;
}

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  ready: "Ready",
  setup: "Needs setup",
  definition: "Definition only",
};
