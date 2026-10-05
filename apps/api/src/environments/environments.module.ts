import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { EnvironmentsService } from "./environments.service";
import { EnvironmentsController } from "./environments.controller";

@Module({ imports: [AuthModule], providers: [EnvironmentsService], controllers: [EnvironmentsController] })
export class EnvironmentsModule {}
