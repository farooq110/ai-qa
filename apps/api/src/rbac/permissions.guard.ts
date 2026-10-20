import { CanActivate, ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission } from "@ai-qa/domain";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PermissionsService } from "./permissions.service";

const KEY = "required-permissions";
/** On a class sets the default for every route; a method-level decorator overrides it. */
export const RequirePermission = (...permissions: Permission[]) => SetMetadata(KEY, permissions);

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly permissions: PermissionsService) {}

  async canActivate(context: ExecutionContext) {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(KEY, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>().user;
    await this.permissions.assert(user, ...required);
    return true;
  }
}
