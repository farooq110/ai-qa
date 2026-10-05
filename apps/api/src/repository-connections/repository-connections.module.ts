import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RepositoryConnectionsController } from "./repository-connections.controller";
import { RepositoryConnectionsService } from "./repository-connections.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [RepositoryConnectionsController], providers: [RepositoryConnectionsService], exports: [RepositoryConnectionsService] })
export class RepositoryConnectionsModule {}