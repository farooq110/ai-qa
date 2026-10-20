import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { GenerationsController } from "./generations.controller";
import { GenerationsService } from "./generations.service";
import { GenerationProcessor } from "./generation.processor";

@Module({ imports: [AuthModule, DatabaseModule], controllers: [GenerationsController], providers: [GenerationsService, GenerationProcessor] })
export class GenerationsModule {}