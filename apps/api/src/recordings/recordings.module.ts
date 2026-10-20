import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RouteMapModule } from "../route-map/route-map.module";
import { RecordingsService } from "./recordings.service";
import { RecordingsController, RecorderInstallerController } from "./recordings.controller";

@Module({
  imports: [AuthModule, RouteMapModule],
  providers: [RecordingsService],
  controllers: [RecordingsController, RecorderInstallerController]
})
export class RecordingsModule {}
