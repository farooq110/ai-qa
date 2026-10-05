import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedUser } from "./auth.types";

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return (context.switchToHttp().getRequest<FastifyRequest & { user: AuthenticatedUser }>()).user;
});