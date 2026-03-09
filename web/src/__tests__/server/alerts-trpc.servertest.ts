/** @jest-environment node */

import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { prisma } from "@langfuse/shared/src/db";
import {
  createOrgProjectAndApiKey,
  createTrace,
  createTracesCh,
} from "@langfuse/shared/src/server";
import type { Session } from "next-auth";
import { v4 } from "uuid";

const __orgIds: string[] = [];

async function prepare({ admin = false }: { admin?: boolean } = {}) {
  const { project, org } = await createOrgProjectAndApiKey();

  const session: Session = {
    expires: "1",
    user: {
      id: "user-1",
      canCreateOrganizations: true,
      name: "Demo User",
      organizations: [
        {
          id: org.id,
          name: org.name,
          role: "OWNER",
          plan: "cloud:hobby",
          cloudConfig: undefined,
          metadata: {},
          projects: [
            {
              id: project.id,
              role: "ADMIN",
              retentionDays: 30,
              deletedAt: null,
              name: project.name,
              metadata: {},
            },
          ],
        },
      ],
      featureFlags: {
        excludeClickhouseRead: false,
        templateFlag: true,
      },
      admin,
    },
    environment: {
      enableExperimentalFeatures: false,
      selfHostedInstancePlan: "cloud:hobby",
    },
  };

  const ctx = createInnerTRPCContext({ session, headers: {} });
  const caller = appRouter.createCaller({ ...ctx, prisma });

  __orgIds.push(org.id);

  return { project, org, session, ctx, caller };
}

describe("alerts trpc", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: {
        id: { in: __orgIds },
      },
    });
  });

  describe("alerts.evaluateAlertQuery", () => {
    it("evaluates without error for a valid alert", async () => {
      const { project, caller } = await prepare();

      await createTracesCh(
        Array.from({ length: 3 }, () =>
          createTrace({
            project_id: project.id,
            timestamp: Date.now() - 60_000,
          }),
        ),
      );

      const alert = await prisma.alert.create({
        data: {
          id: v4(),
          projectId: project.id,
          name: "Test Alert",
          description: "A test alert",
          status: "ACTIVE",
          view: "TRACES",
          dimensions: [],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 100,
        },
      });

      await expect(
        caller.alerts.evaluateAlertQuery({
          projectId: project.id,
          alertId: alert.id,
        }),
      ).resolves.not.toThrow();
    });

    it("throws for a non-existent alert id", async () => {
      const { project, caller } = await prepare();

      await expect(
        caller.alerts.evaluateAlertQuery({
          projectId: project.id,
          alertId: "non-existent-id",
        }),
      ).rejects.toThrow(/not found/i);
    });
  });
});
