import { Body, Controller, Get, Headers, Post, Req, UseGuards } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BillingService } from "./billing.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("v1/billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get("plans")
  plans() {
    return this.billingService.publicPlans();
  }

  @UseGuards(AuthGuard)
  @Get("summary")
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.summary(user.organizationId);
  }

  @UseGuards(AuthGuard)
  @Post("checkout")
  checkout(@CurrentUser() user: AuthenticatedUser, @Body() body: { planKey: string; interval: string }) {
    return this.billingService.createCheckout(user, body.planKey, body.interval);
  }

  @UseGuards(AuthGuard)
  @Post("portal")
  portal(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.createPortal(user);
  }

  @Post("webhook/stripe")
  stripeWebhook(@Req() request: RawBodyRequest<FastifyRequest>, @Headers("stripe-signature") signature?: string) {
    return this.billingService.handleWebhook(request.rawBody, signature);
  }
}
