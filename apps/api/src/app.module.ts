import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { HealthController } from "./health.controller";
import { ProjectsModule } from "./projects/projects.module";
import { TestCasesModule } from "./test-cases/test-cases.module";
import { ExecutionsModule } from "./executions/executions.module";
import { ClassificationsModule } from "./classifications/classifications.module";
import { GenerationsModule } from "./generations/generations.module";
import { RepositoryConnectionsModule } from "./repository-connections/repository-connections.module";
import { AnalysisModule } from "./analysis/analysis.module";
import { TeamModule } from "./team/team.module";
import { EnvironmentsModule } from "./environments/environments.module";
import { BillingModule } from "./billing/billing.module";
import { CiModule } from "./ci/ci.module";
import { AdminModule } from "./admin/admin.module";
import { OverviewModule } from "./overview/overview.module";
import { ArtifactsModule } from "./artifacts/artifacts.module";
import { RecordingsModule } from "./recordings/recordings.module";
import { CommonModule } from "./common/common.module";

@Module({
	imports: [ConfigModule.forRoot({ isGlobal: true }), CommonModule, AuthModule, ProjectsModule, TestCasesModule, ExecutionsModule, ClassificationsModule, GenerationsModule, RepositoryConnectionsModule, AnalysisModule, TeamModule, EnvironmentsModule, BillingModule, CiModule, AdminModule, OverviewModule, ArtifactsModule, RecordingsModule],
	controllers: [HealthController]
})
export class AppModule {}
