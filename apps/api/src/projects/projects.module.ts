import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { ProjectsController } from "./projects.controller";
import { ProjectsService } from "./projects.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [ProjectsController], providers: [ProjectsService] })
export class ProjectsModule {}