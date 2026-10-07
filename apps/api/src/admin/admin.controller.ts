import { Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { AdminService } from "./admin.service";
import { SuperadminGuard } from "../auth/auth.guard";

@UseGuards(SuperadminGuard)
@Controller("v1/admin")
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get("overview") overview() { return this.adminService.overview(); }
  @Get("organizations") organizations() { return this.adminService.organizations(); }
  @Get("plans") plans() { return this.adminService.plans(); }
  @Get("workers") workers() { return this.adminService.workers(); }
  @Get("audit") audit(@Query("take") take?: string) { return this.adminService.auditTrail(take ? Math.min(Number(take) || 100, 500) : 100); }
  @Get("support-queries") supportQueries() { return this.adminService.supportQueryList(); }

  @Patch("organizations/:organizationId/subscription")
  updateSubscription(@Param("organizationId") organizationId: string, @Body() body: { status?: string }) {
    return this.adminService.updateSubscriptionStatus(organizationId, body.status ?? "");
  }

  @Patch("support-queries/:id")
  updateSupportQueryStatus(@Param("id") id: string, @Body() body: { status?: string }) {
    return this.adminService.updateSupportQueryStatus(id, body.status ?? "");
  }
}
