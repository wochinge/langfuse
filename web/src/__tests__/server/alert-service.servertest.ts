/** @jest-environment node */

import { prisma } from "@langfuse/shared/src/db";
import {
  createOrgProjectAndApiKey,
  createTrace,
  createTracesCh,
  createObservation,
  createObservationsCh,
} from "@langfuse/shared/src/server";
import { v4 } from "uuid";
import { evaluateAlert } from "@/src/features/alerts/server/alertService";

const __orgIds: string[] = [];

async function prepareProject() {
  const { project, org } = await createOrgProjectAndApiKey();
  __orgIds.push(org.id);
  return project;
}

describe("evaluateAlert service", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: __orgIds } },
    });
  });

  it("throws for non-existent alert", async () => {
    const project = await prepareProject();

    await expect(
      evaluateAlert({
        projectId: project.id,
        alertId: "non-existent-id",
      }),
    ).rejects.toThrow("not found");
  });

  it("does not create history when not breached and no prior history", async () => {
    const project = await prepareProject();

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
        name: "Low Volume Alert",
        description: "Alert when trace count > 100",
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

    await evaluateAlert({
      projectId: project.id,
      alertId: alert.id,
    });

    const history = await prisma.alertHistory.findMany({
      where: { alertId: alert.id },
    });
    expect(history).toHaveLength(0);
  });

  describe("test breaching / resolving", () => {
    it("test breach with no previous history", async () => {
      const project = await prepareProject();

      await createTracesCh(
        Array.from({ length: 5 }, () =>
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
          name: "New Breach",
          description: "No prior history",
          status: "ACTIVE",
          view: "TRACES",
          dimensions: [],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 2,
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("ALERT");
    });

    it("test resolving after previous alert", async () => {
      const project = await prepareProject();

      await createTracesCh(
        Array.from({ length: 2 }, () =>
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
          name: "Resolving Alert",
          description: "Was breached, now resolved",
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

      await prisma.alertHistory.create({
        data: {
          alertId: alert.id,
          projectId: project.id,
          status: "ALERT",
          debuggingLink: "",
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
        orderBy: { createdAt: "desc" },
      });
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("OK");
    });

    it("test no new entry if not breached and previous was OK", async () => {
      const project = await prepareProject();

      await createTracesCh([
        createTrace({
          project_id: project.id,
          timestamp: Date.now() - 60_000,
        }),
      ]);

      const alert = await prisma.alert.create({
        data: {
          id: v4(),
          projectId: project.id,
          name: "Steady OK",
          description: "Was OK, still OK",
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

      await prisma.alertHistory.create({
        data: {
          alertId: alert.id,
          projectId: project.id,
          status: "OK",
          debuggingLink: "",
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
      });
      expect(history).toHaveLength(1);
    });

    it("test reducing noise for recent alerts", async () => {
      const project = await prepareProject();

      await createTracesCh(
        Array.from({ length: 5 }, () =>
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
          name: "Recent Alert",
          description: "Already alerted recently",
          status: "ACTIVE",
          view: "TRACES",
          dimensions: [],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 2,
        },
      });

      await prisma.alertHistory.create({
        data: {
          alertId: alert.id,
          projectId: project.id,
          status: "ALERT",
          debuggingLink: "",
          createdAt: new Date(Date.now() - 2 * 60_000),
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
      });
      expect(history).toHaveLength(1);
    });

    it("test re-alert if previous alert was long ago", async () => {
      const project = await prepareProject();
      await createTracesCh(
        Array.from({ length: 5 }, () =>
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
          name: "Old Alert",
          description: "Previous alert was long ago",
          status: "ACTIVE",
          view: "TRACES",
          dimensions: [],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 2,
        },
      });

      await prisma.alertHistory.create({
        data: {
          alertId: alert.id,
          projectId: project.id,
          status: "ALERT",
          debuggingLink: "",
          createdAt: new Date(Date.now() - 10 * 60_000),
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
        orderBy: { createdAt: "desc" },
      });
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("ALERT");
    });
  });

  describe("breakout queries", () => {
    it("breaches when any group exceeds threshold", async () => {
      const project = await prepareProject();

      const traceId = v4();
      await createTracesCh([
        createTrace({
          id: traceId,
          project_id: project.id,
          timestamp: Date.now() - 60_000,
        }),
      ]);

      await createObservationsCh([
        ...Array.from({ length: 3 }, () =>
          createObservation({
            project_id: project.id,
            trace_id: traceId,
            start_time: Date.now() - 60_000,
            provided_model_name: "gpt-4",
          }),
        ),
        ...Array.from({ length: 1 }, () =>
          createObservation({
            project_id: project.id,
            trace_id: traceId,
            start_time: Date.now() - 60_000,
            provided_model_name: "gpt-3.5",
          }),
        ),
      ]);

      const alert = await prisma.alert.create({
        data: {
          id: v4(),
          projectId: project.id,
          name: "Breakout Breach",
          description: "One group exceeds threshold",
          status: "ACTIVE",
          view: "OBSERVATIONS",
          dimensions: [{ field: "providedModelName" }],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 2,
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
      });
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("ALERT");
    });

    it("does not breach when no group exceeds threshold", async () => {
      const project = await prepareProject();

      const traceId = v4();
      await createTracesCh([
        createTrace({
          id: traceId,
          project_id: project.id,
          timestamp: Date.now() - 60_000,
        }),
      ]);

      await createObservationsCh([
        createObservation({
          project_id: project.id,
          trace_id: traceId,
          start_time: Date.now() - 60_000,
          provided_model_name: "gpt-4",
        }),
        createObservation({
          project_id: project.id,
          trace_id: traceId,
          start_time: Date.now() - 60_000,
          provided_model_name: "gpt-3.5",
        }),
      ]);

      const alert = await prisma.alert.create({
        data: {
          id: v4(),
          projectId: project.id,
          name: "Breakout No Breach",
          description: "No group exceeds threshold",
          status: "ACTIVE",
          view: "OBSERVATIONS",
          dimensions: [{ field: "providedModelName" }],
          metrics: [{ measure: "count", aggregation: "count" }],
          filters: [],
          evaluationWindowSeconds: 3600,
          operator: "GT",
          threshold: 10,
        },
      });

      await evaluateAlert({
        projectId: project.id,
        alertId: alert.id,
      });

      const history = await prisma.alertHistory.findMany({
        where: { alertId: alert.id },
      });
      expect(history).toHaveLength(0);
    });
  });
});
