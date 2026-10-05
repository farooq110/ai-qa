import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { RecordingsService } from "./recordings.service";
import { RecordingsController } from "./recordings.controller";

@Module({
  imports: [AuthModule],
  providers: [RecordingsService],
  controllers: [RecordingsController]
})
export class RecordingsModule {}
