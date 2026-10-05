import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { ClassificationsController } from "./classifications.controller";
import { ClassificationsService } from "./classifications.service";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [ClassificationsController], providers: [ClassificationsService] })
export class ClassificationsModule {}