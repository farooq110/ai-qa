import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RepositoryConnectionsModule } from "../repository-connections/repository-connections.module";
import { AnalysisController } from "./analysis.controller";
import { AnalysisService } from "./analysis.service";

@Module({ imports: [AuthModule, DatabaseModule, RepositoryConnectionsModule], controllers: [AnalysisController], providers: [AnalysisService] })
export class AnalysisModule {}