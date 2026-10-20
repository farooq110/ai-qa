import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RepositoryConnectionsModule } from "../repository-connections/repository-connections.module";
import { CiService } from "./ci.service";
import { CiReporterService } from "./ci-reporter.service";
import { CiController, CiWebhookController } from "./ci.controller";

@Module({ imports: [AuthModule, RepositoryConnectionsModule], providers: [CiService, CiReporterService], controllers: [CiController, CiWebhookController], exports: [CiService] })
export class CiModule {}
