import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { CiService } from "./ci.service";
import { CiController, CiWebhookController } from "./ci.controller";

@Module({ imports: [AuthModule], providers: [CiService], controllers: [CiController, CiWebhookController] })
export class CiModule {}
