import type { APP_ROLES } from "@ai-qa/domain";

export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  role: APP_ROLES;
}

export interface AccessTokenPayload extends AuthenticatedUser {
  sub: string;
}