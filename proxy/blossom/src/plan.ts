import { Plan } from "./generated/prisma/client.js";

export const PLAN_CONFIG = {
  [Plan.FREE]: {
    storageLimit: 15 * 1024 ** 3,
    uploadLimit: 50 * 1024 ** 2,
    replicaCount: 1,
  },
  [Plan.BASIC]: {
    storageLimit: 50 * 1024 ** 3,
    uploadLimit: 500 * 1024 ** 2,
    replicaCount: 3,
  },
  [Plan.PRO]: {
    storageLimit: 100 * 1024 ** 3,
    uploadLimit: 2 * 1024 ** 3,
    replicaCount: 5,
  },
} satisfies Record<
  Plan,
  {
    storageLimit: number;
    uploadLimit: number;
    replicaCount: number;
  }
>;