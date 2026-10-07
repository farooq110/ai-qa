import { Module } from "@nestjs/common";
import { SupportQueriesController } from "./support-queries.controller";
import { SupportQueriesService } from "./support-queries.service";

@Module({ controllers: [SupportQueriesController], providers: [SupportQueriesService], exports: [SupportQueriesService] })
export class SupportQueriesModule {}
