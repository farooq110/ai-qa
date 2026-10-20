import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { DatabaseModule } from "../database/database.module";
import { RbacModule } from "../rbac/rbac.module";
import { RouteMapController } from "./route-map.controller";
import { RouteMapService } from "./route-map.service";

@Module({ imports: [AuthModule, DatabaseModule, RbacModule], controllers: [RouteMapController], providers: [RouteMapService], exports: [RouteMapService] })
export class RouteMapModule {}
