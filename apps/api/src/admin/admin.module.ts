import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { SupportQueriesModule } from "../support-queries/support-queries.module";
import { AdminService } from "./admin.service";
import { AdminController } from "./admin.controller";

@Module({ imports: [AuthModule, SupportQueriesModule], providers: [AdminService], controllers: [AdminController] })
export class AdminModule {}
