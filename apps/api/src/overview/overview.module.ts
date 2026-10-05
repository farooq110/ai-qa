import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { OverviewService } from "./overview.service";
import { OverviewController } from "./overview.controller";

@Module({ imports: [AuthModule], providers: [OverviewService], controllers: [OverviewController] })
export class OverviewModule {}
