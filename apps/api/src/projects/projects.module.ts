import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RepositoryConnectionsModule } from "../repository-connections/repository-connections.module";
import { CiModule } from "../ci/ci.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({ imports: [AuthModule, DatabaseModule, RepositoryConnectionsModule, CiModule], controllers: [ProjectsController], providers: [ProjectsService] })
export class ProjectsModule {}