import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { ArtifactsController } from "./artifacts.controller";

@Module({ imports: [AuthModule], controllers: [ArtifactsController] })
export class ArtifactsModule {}
