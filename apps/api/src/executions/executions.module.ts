import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { ExecutionsController, ExecutionsLibraryController } from "./executions.controller";
import { ExecutionsService } from "./executions.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [ExecutionsController, ExecutionsLibraryController], providers: [ExecutionsService] })
export class ExecutionsModule {}