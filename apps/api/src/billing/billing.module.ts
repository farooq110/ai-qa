import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { BillingService } from "./billing.service";
import { BillingController } from "./billing.controller";

@Module({ imports: [AuthModule], providers: [BillingService], controllers: [BillingController] })
export class BillingModule {}
