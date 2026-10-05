import { BadRequestException, Body, Controller, Get, Post, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthGuard } from "./auth.guard";
import { CurrentUser } from "./current-user.decorator";
import type { AuthenticatedUser } from "./auth.types";

@Controller("v1/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("signup")
  signUp(@Body() body: { email?: string; password?: string; displayName?: string; organizationName?: string; industry?: string; organizationSize?: string; country?: string }) {
    if (!body.email || !body.password || !body.displayName || !body.organizationName) throw new BadRequestException("email, password, displayName, and organizationName are required");
    if (body.password.length < 12) throw new BadRequestException("password must contain at least 12 characters");
    return this.authService.signUp({ email: body.email, password: body.password, displayName: body.displayName, organizationName: body.organizationName, industry: body.industry, organizationSize: body.organizationSize, country: body.country });
  }

  @Post("signin")
  signIn(@Body() body: { email?: string; password?: string }) {
    if (!body.email || !body.password) throw new BadRequestException("email and password are required");
    return this.authService.signIn({ email: body.email, password: body.password });
  }

  @UseGuards(AuthGuard)
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user.userId);
  }
}
