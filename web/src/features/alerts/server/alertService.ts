import { prisma } from "@langfuse/shared/src/db";
import {
  type DashboardWidgetViews,
  type AlertOperator,
  AlertHistoryStatus,
} from "@langfuse/shared/src/db";
import { executeQuery } from "@/src/features/query/server/queryExecutor";
import { type QueryType } from "@/src/features/query/types";
import { logger } from "@langfuse/shared/src/server";

const viewMapping: Record<DashboardWidgetViews, QueryType["view"]> = {
  TRACES: "traces",
  OBSERVATIONS: "observations",
  SCORES_NUMERIC: "scores-numeric",
  SCORES_CATEGORICAL: "scores-categorical",
};

// Avoid flapping by not recording multiple ALERT statuses within a short time window (e.g. 5 minutes)
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

const OPERATOR_LABELS: Record<AlertOperator, string> = {
  GT: ">",
  GTE: ">=",
  LT: "<",
  LTE: "<=",
};

type AlertEvaluationResult = {
  alertId: string;
  breached: boolean;
  results: Array<{
    dimensions: Record<string, unknown>;
    metricValue: number;
    breached: boolean;
  }>;
};

type AlertWithHistory = NonNullable<Awaited<ReturnType<typeof getAlert>>>;

export async function evaluateAlert({
  projectId,
  alertId,
}: {
  projectId: string;
  alertId: string;
}): Promise<void> {
  const alert = await getAlert({ projectId, alertId });

  if (!alert) {
    throw new Error(`Alert ${alertId} not found in project ${projectId}`);
  }

  const now = new Date();
  const query = buildQuery({ alert, now });
  const queryResults = await executeQuery(projectId, query);

  const results = evaluateResults({ queryResults, alert });
  const breached = results.some((r) => r.breached);

  const newStatus = resolveTransition({ alert, breached, now });

  if (!newStatus) return;

  await recordHistory({ alert, projectId, status: newStatus });
  notify({ alert, results, status: newStatus });
}

// --- Helpers ---

async function getAlert({
  projectId,
  alertId,
}: {
  projectId: string;
  alertId: string;
}) {
  return prisma.alert.findFirst({
    where: {
      id: alertId,
      projectId,
    },
    include: {
      alertHistory: {
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });
}

function buildQuery({
  alert,
  now,
}: {
  alert: AlertWithHistory;
  now: Date;
}): QueryType {
  const fromTimestamp = new Date(
    now.getTime() - alert.evaluationWindowSeconds * 1000,
  );

  return {
    view: viewMapping[alert.view],
    dimensions: alert.dimensions as QueryType["dimensions"],
    metrics: alert.metrics as QueryType["metrics"],
    filters: alert.filters as QueryType["filters"],
    timeDimension: null,
    fromTimestamp: fromTimestamp.toISOString(),
    toTimestamp: now.toISOString(),
    orderBy: null,
  };
}

function evaluateResults({
  queryResults,
  alert,
}: {
  queryResults: Record<string, unknown>[];
  alert: AlertWithHistory;
}): AlertEvaluationResult["results"] {
  const metrics = alert.metrics as QueryType["metrics"];
  const dimensions = alert.dimensions as QueryType["dimensions"];
  const metricKey = `${metrics[0].aggregation}_${metrics[0].measure}`;
  const dimensionFields = dimensions.map((d) => d.field);

  return queryResults.map((row) => {
    const metricValue = Number(row[metricKey] ?? 0);
    const breached = isThresholdBreached({
      value: metricValue,
      operator: alert.operator,
      threshold: alert.threshold,
    });

    const dims: Record<string, unknown> = {};
    for (const field of dimensionFields) {
      dims[field] = row[field];
    }

    return { dimensions: dims, metricValue, breached };
  });
}

function isThresholdBreached({
  value,
  operator,
  threshold,
}: {
  value: number;
  operator: AlertOperator;
  threshold: number;
}): boolean {
  switch (operator) {
    case "GT":
      return value > threshold;
    case "GTE":
      return value >= threshold;
    case "LT":
      return value < threshold;
    case "LTE":
      return value <= threshold;
  }
}

function resolveTransition({
  alert,
  breached,
  now,
}: {
  alert: AlertWithHistory;
  breached: boolean;
  now: Date;
}): AlertHistoryStatus | null {
  const latestHistory = alert.alertHistory[0] ?? null;
  const dedupCutoff = new Date(now.getTime() - DEDUP_WINDOW_MS);

  if (breached) {
    const shouldCreate =
      !latestHistory ||
      latestHistory.status !== AlertHistoryStatus.ALERT ||
      latestHistory.createdAt < dedupCutoff;

    return shouldCreate ? AlertHistoryStatus.ALERT : null;
  }

  // Not breached - only transition to OK if previous was ALERT
  return latestHistory?.status === AlertHistoryStatus.ALERT
    ? AlertHistoryStatus.OK
    : null;
}

async function recordHistory({
  alert,
  projectId,
  status,
}: {
  alert: AlertWithHistory;
  projectId: string;
  status: AlertHistoryStatus;
}) {
  await prisma.alertHistory.create({
    data: {
      alertId: alert.id,
      projectId,
      status,
      debuggingLink: "",
    },
  });
}

function notify({
  alert,
  results,
  status,
}: {
  alert: AlertWithHistory;
  results: AlertEvaluationResult["results"];
  status: AlertHistoryStatus;
}) {
  // TODO: replace with email / slack / webhook
  if (status === AlertHistoryStatus.OK) {
    console.log(`Alert "${alert.name}" resolved`);
    return;
  }

  const breachedResults = results.filter((r) => r.breached);
  const operatorLabel = OPERATOR_LABELS[alert.operator];
  const dimensionFields = Object.keys(breachedResults[0]?.dimensions ?? {});
  const hasBreakout = dimensionFields.length > 0;

  if (hasBreakout) {
    const groups = breachedResults
      .map((r) => {
        const groupName = dimensionFields
          .map((f) => `${f}=${r.dimensions[f]}`)
          .join(", ");
        return `  ${groupName}: ${r.metricValue} (threshold ${operatorLabel} ${alert.threshold})`;
      })
      .join("\n");

    console.log(`Alert "${alert.name}" breached for groups:\n${groups}`);
  } else {
    const value = breachedResults[0]?.metricValue;

    console.log(
      `Alert "${alert.name}" breached: ${value} ${operatorLabel} ${alert.threshold}`,
    );
  }
}
