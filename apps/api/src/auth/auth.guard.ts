import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../database/prisma.service";
import type { FastifyRequest } from "fastify";
import type { AccessTokenPayload, AuthenticatedUser } from "./auth.types";

type RequestWithUser = FastifyRequest & { user?: AuthenticatedUser };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("A bearer token is required");

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
      request.user = { userId: payload.userId, organizationId: payload.organizationId, role: payload.role };
      return true;
    } catch {
      throw new UnauthorizedException("The access token is invalid or expired");
    }
  }
}

@Injectable()
export class SuperadminGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) throw new UnauthorizedException("A bearer token is required");
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new UnauthorizedException("The access token is invalid or expired");
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user?.isSuperadmin) throw new ForbiddenException("This area requires platform superadmin access");
    request.user = { userId: payload.userId, organizationId: payload.organizationId ?? "", role: payload.role };
    return true;
  }
}
