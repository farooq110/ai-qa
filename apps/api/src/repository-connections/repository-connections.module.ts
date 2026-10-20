import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { IntegrationCredentialsController } from "./credentials.controller";
import { RepositoryConnectionsController } from "./repository-connections.controller";
import { RepositoryConnectionsService } from "./repository-connections.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [RepositoryConnectionsController, IntegrationCredentialsController], providers: [RepositoryConnectionsService], exports: [RepositoryConnectionsService] })
export class RepositoryConnectionsModule {}