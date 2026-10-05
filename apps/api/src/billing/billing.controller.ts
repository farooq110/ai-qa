import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { BillingService } from "./billing.service";
import { AuthGuard } from "../auth/auth.guard";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";

@Controller("v1/billing")
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @UseGuards(AuthGuard)
  @Get("summary")
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.summary(user.organizationId);
  }

  @Post("webhook/stripe")
  async stripeWebhook(@Req() request: FastifyRequest) {
    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const signature = request.headers["stripe-signature"];
    return this.billingService.handleStripeWebhook(rawBody, Array.isArray(signature) ? signature[0] : signature);
  }
}
