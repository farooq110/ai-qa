import { BadRequestException, Body, Controller, Get, Patch, Post, UseGuards } from "@nestjs/common";
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

  @Post("verify-email")
  verifyEmail(@Body() body: { token?: string }) {
    if (!body.token) throw new BadRequestException("token is required");
    return this.authService.verifyEmail(body.token);
  }

  @Post("resend-verification")
  resendVerification(@Body() body: { email?: string }) {
    if (!body.email) throw new BadRequestException("email is required");
    return this.authService.resendVerification(body.email);
  }

  @Post("forgot-password")
  forgotPassword(@Body() body: { email?: string }) {
    if (!body.email) throw new BadRequestException("email is required");
    return this.authService.forgotPassword(body.email);
  }

  @Post("reset-password")
  resetPassword(@Body() body: { token?: string; password?: string }) {
    if (!body.token || !body.password) throw new BadRequestException("token and password are required");
    if (body.password.length < 12) throw new BadRequestException("password must contain at least 12 characters");
    return this.authService.resetPassword(body.token, body.password);
  }

  @UseGuards(AuthGuard)
  @Get("me")
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.me(user.userId);
  }

  @UseGuards(AuthGuard)
  @Patch("me")
  updateProfile(@CurrentUser() user: AuthenticatedUser, @Body() body: { displayName?: string }) {
    const displayName = body.displayName?.trim();
    if (!displayName) throw new BadRequestException("Name can't be empty");
    if (displayName.length > 80) throw new BadRequestException("Name must be 80 characters or fewer");
    return this.authService.updateProfile(user.userId, { displayName });
  }

  @UseGuards(AuthGuard)
  @Post("change-password")
  changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: { currentPassword?: string; newPassword?: string }) {
    if (!body.currentPassword || !body.newPassword) throw new BadRequestException("currentPassword and newPassword are required");
    if (body.newPassword.length < 12) throw new BadRequestException("password must contain at least 12 characters");
    return this.authService.changePassword(user, body.currentPassword, body.newPassword);
  }
}
