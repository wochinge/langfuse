import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { z } from "zod/v4";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import { evaluateAlert } from "./alertService";

export const alertRouter = createTRPCRouter({
  evaluateAlertQuery: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        alertId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "alerts:read",
      });

      await evaluateAlert({
        projectId: input.projectId,
        alertId: input.alertId,
      });
    }),
});
