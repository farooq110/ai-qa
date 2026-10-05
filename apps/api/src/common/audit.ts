import { PrismaService } from "../database/prisma.service";

export interface AuditInput {
  organizationId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  scope?: "ORGANIZATION" | "PLATFORM";
}

export async function recordAudit(prisma: PrismaService, input: AuditInput) {
  try {
    await prisma.auditEvent.create({
      data: {
        organizationId: input.organizationId ?? undefined,
        actorId: input.actorId ?? undefined,
        actorEmail: input.actorEmail ?? undefined,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata as never,
        scope: input.scope ?? "ORGANIZATION"
      }
    });
  } catch {
    // Audit logging must never break the primary action.
  }
}
