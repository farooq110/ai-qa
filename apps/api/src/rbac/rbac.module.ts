import { Global, Module } from "@nestjs/common";
import { PermissionsGuard } from "./permissions.guard";
import { PermissionsService } from "./permissions.service";

@Global()
@Module({ providers: [PermissionsService, PermissionsGuard], exports: [PermissionsService, PermissionsGuard] })
export class RbacModule {}
