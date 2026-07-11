import type { DbClient, PlanConfig } from "@orchestrator/db-client";

let planConfigPromise: Promise<PlanConfig> | undefined;

export function getPlanConfig(db: DbClient): Promise<PlanConfig> {
  if (!planConfigPromise) {
    planConfigPromise = db.getPlans();
  }
  return planConfigPromise;
}
